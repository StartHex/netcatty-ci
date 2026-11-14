# 数据库工作台：在 SSH 主机上直连（on-host 驱动）

> 状态：已实现；自动化测试通过（含 Python 2.7 / 3.6 / 3.13）；**尚未在真实客户端库和真实堡垒机上验证**
> 分支：`feat/onhost-db-driver`
> 关联：`database-workbench-jdbc.md`（JDBC 与 SSH 隧道）

---

## 0. 结论摘要

1. 有一类数据库**只能从应用主机上连**：端口不对外，SSH 隧道也不管用——集群的客户端协议会把
   连接引到别的地址（先连 rootserver，再连各节点），转发一个端口跟不过去。典型报错：
   `MDB-99998: cannot connect to rootserver(127.0.0.1:xxxxx)`。
2. 应用主机上本来就有厂商的客户端库和现成配置（DSCI 及其背后的内存库客户端）。所以不去
   "够"数据库，而是**把连接动作放到主机上做**：SSH 登录主机 → 在主机上起一个小代理 → 代理用
   主机上的库连库 → 查询结果传回工作台。不做端口转发，不走跳板隧道。
3. 代理是**一个 Python 文件**，只用标准库，兼容 2.7 和 3.x，通过终端"敲"进解释器，
   **主机上不落地任何文件、不需要安装任何东西**。
4. 经堡垒机的主机（先登录平台，再输入 IP、选账号）用"进入 shell 前的步骤"描述：等到某段
   文字出现就输入一段内容。步骤全部完成后才开始连库。
5. 仓库里**不包含任何厂商代码、头文件或配置**：代理在运行时按函数名绑定主机上的库，测试
   用自己写的替身库。

---

## 1. 整体结构

```
渲染进程                         主进程                                SSH 主机
────────                         ──────                                ────────
DatabaseConnection(kind=onhost)
  │ ensureDatabaseTunnel
  ▼
portForwardingService ─────────► portForwardingBridge
  shellRelay: true                 本地回环端口 + 一次性令牌 ───────►  登录 shell（PTY）
  ◄──── localPort, relayToken                                              ▲
  │                                                                        │ 逐行
  ▼ dbConnect(target)                                                      │ base64 帧
dbBridge ──────────────────────► dbAgent/onHostSession                     │
                                   └ agentLink：步骤 → shell → 代理 ───────┘
                                                              netcatty_dbagent.py
                                                                └ ctypes → 主机上的客户端库
```

为什么借用端口转发：登录主机要处理的事情（密钥、密码、跳板链、动态口令、主机密钥校验、
代理、保活）端口转发已经全做了。给它加一种"终点是主机 shell"的本地转发（shell relay），
驱动拿到一个本地端口即可，登录逻辑一行不用重写。

---

## 2. Shell relay（`portForwardShellRelay.cjs`、`portForwardingBridge.cjs`）

- `PortForwardOptions.shellRelay = true`（仅 `local` 类型）：每个连到本地端口的连接得到一个
  新的登录 shell（`xterm`，200×50，足够宽，驱动敲的行不会被终端折行）。
- shell 比数据库套接字危险得多，所以：
  - 只允许绑定回环地址，其它地址直接拒绝；
  - 启动结果带一个一次性令牌（48 个十六进制字符），客户端必须把它作为**第一行**发来，
    常数时间比较；令牌不对、行过长、5 秒内没发，直接断开，不开 shell；
  - 令牌只存在于隧道状态和这一次启动结果里，不写日志。
- `verifyRemote` 对它没有意义（没有可探测的目标），直接视为就绪。
- 数据库这边使用**独立的 SSH 连接**（`dedicatedTransport`）：堡垒机的选主机菜单属于一次
  登录；有些堡垒机一条连接只允许一个通道。

---

## 3. 从"一个终端"到"代理就绪"（`agentLink.cjs`）

全部靠"敲键盘"完成，顺序固定：

| 步骤 | 做什么 | 超时 | 失败码 |
| --- | --- | --- | --- |
| 1 | 依次执行"进入 shell 前的步骤"：等文字 → 输入 → 回车 | 每步 30 秒（可逐步配置） | `onhost-login-step` |
| 2 | 确认 shell：敲 `echo __NC''RDY…__`，等它的输出（每 4 秒重敲一次） | 40 秒 | `onhost-no-shell` |
| 3 | `stty -echo`；执行可选的环境命令 | 30 秒 | `onhost-env` |
| 4 | 依次尝试 `python3`、`python`、`python2`、`/usr/libexec/platform-python`（或用户指定的路径） | 20 秒 | `onhost-no-python` |
| 5 | 把代理（deflate + base64，76 字符一行）敲进解释器，等 `READY` 帧 | 30 秒 | `onhost-agent-start` |

细节：

- **标记中间夹一个引号**（`__NC''RDY__`）：shell 输出时没有引号，所以终端对命令本身的回显
  永远不会被当成命令的输出。
- 解释器一行启动：从终端读 N 字节 base64、解压、`exec`。启动行末尾跟着
  `; echo @NC''@ 0 EXIT`，所以"没有这个解释器"和"代理退出了"都能被发现，不会把请求敲进
  shell 提示符里。
- 失败时把主机最近打印的若干行（去掉 ANSI 序列，UTF-8 不合法时按 GBK 解码）作为详情带回
  界面。登录步骤等不到提示时，这就是用户改步骤的依据。
- 整个连接过程的总时限是 180 秒（普通驱动 45 秒）。

---

## 4. 帧协议（`frames.cjs`，代理内有对等实现）

双向都是"一行一帧"：

```
@NCQ@ <id> + <chunk>                 请求，后面还有分片
@NCQ@ <id> <METHOD> <crc> <chunk>    请求，最后一片
@NC@  <id> + <chunk>                 响应，后面还有分片
@NC@  <id> <KIND> <crc> <chunk>      响应，最后一片
```

- 分片拼起来是 `base64(zlib(JSON))`，`crc` 是这段 base64 文本的 CRC-32。
- 流里其它任何内容（提示符、横幅、客户端库自己打印的东西、请求的回显）都不是帧，直接忽略。
  请求和响应用不同的标记，所以即使回显没关掉，请求也不会被当成响应。
- 请求：`OPEN`、`QUERY`、`BEGIN` / `COMMIT` / `ROLLBACK`、`CANCEL`、`PING`、`DIAG`、`CLOSE`。
- 响应：`READY`（代理身份）、`COLS`、`ROWS`（按批）、`OK`、`ERR`（`code`、`message`、原生错误号）。

---

## 5. 代理（`agent/netcatty_dbagent.py`）

- 单文件、标准库、Python 2.7 与 3.x 同一份代码。CI 在 2.7、3.6、3.13 三个解释器下跑它
  自己的测试。
- 用 `ctypes` 加载主机上的库，查找顺序：`$DSCI_PATH/lib`、`$DCI_HOME/dci/lib` 等约定位置，
  然后是动态加载器的默认路径（`LD_LIBRARY_PATH`）。
- 两种打开方式：
  - **config**：读 `$DSCI_PATH/cfg/db.cfg`，按编号（或 `DEFAULT_DB`）选库，登录信息由库自己
    从配置指向的登录文件里取——**账号密码不经过 Netcatty**；
  - **direct**：用界面上填的账号、类型、服务地址。DSCI 不支持该类型或主机上没有 DSCI 时，
    内存库类型退回到它自己的客户端库。
- 内存库（dmdb / imdb）优先走原生客户端：能拿到列名、能执行任意语句、能中断结果集。
  其它类型走 DSCI 的公共接口，语句范围受 DSCI 限制（select / insert / update / delete /
  truncate table / create table，select 必须带 from）。
- 不在事务里时，每条语句执行后自动提交，失败则回滚。
- 行按批回传（行数或字节数先到者为准）；达到行数上限后放弃剩余结果集并标记截断。
- 编码：`auto` 按主机 locale 推断，不是合法 UTF-8 的文本按 GB18030 解码；也可以显式指定。
- `DIAG`：报告 Python 版本、几个路径类环境变量、各个库能否加载及原因、db.cfg 里的库名和
  类型。连接失败（库加载不了 / 连不上）时自动附在错误详情里。**不读取登录文件。**

---

## 6. 会话（`onHostSession.cjs`）

对 `dbBridge` 暴露和其它驱动相同的接口：`serverVersion`、`query`、`execute`、`tables`、
`columns`、`control`、`cancel`、`close`、`forceClose`、`generation`。

- **列名**：库不给列名时，`select a, b from t` 取语句里的名字；`select * from t` 取表结构；
  都取不到用 `COL1…`（`sqlShape.cjs`）。
- **表结构树**：内存库用 `dba_tables` + `desc`；mysql / opengauss 用 `information_schema`；
  oracle 用 `all_tables` / `all_tab_columns`；其它类型暂不提供。
- **取消**：读结果集时让代理停；服务器还在计算时只能结束代理，随后的语句自动重新登录
  （`generation` 加一，`dbBridge` 据此报告事务已丢失）。
- **心跳**：空闲时每 45 秒 `PING` 一次，避免堡垒机和空闲策略踢掉会话。工作台的空闲探测对
  这种连接也改为 ping，而不是发 `select 1`（没有一条语句对所有后端都合法）。
- **登录途中关闭**：会话在登录/启动代理的过程中被关闭（超时、标签提前关掉）时，立即结束
  这次登录，不在主机上留下一个没人用的 shell。

---

## 7. 渲染进程

- 模型：`DatabaseKind` 增加 `onhost`；`DatabaseConnection.onHost: OnHostDatabaseSettings`
  （`mode`、`dbNo`、`dbType`、`server`、`envCommand`、`python`、`loginSteps`）。
  `sshHostId` 在这里是必填项（驱动运行的地方），不是可选的跳板。
- 表单：`components/databases/OnHostConnectionFields.tsx`；逻辑在
  `domain/database/onHostForm.ts`（缺什么、步骤增删改、与设置互转）。
- 隧道：`databaseTunnelService` 为这类连接申请 shell relay，并把令牌放进连接目标。
- **测试连接**使用独立通道，测完即关。以前测试和已保存的连接共用隧道键：测试一份改过的
  草稿会拆掉已打开标签正在用的隧道；测试一份没保存的草稿会把隧道留在后台。
- 错误：连接/测试结果带上桥的错误码和详情；`databaseErrorMessages.ts` 给每个登录阶段一行
  译文，后面跟具体信息。
- 登录步骤**以明文保存**（会随导出、同步带走），表单上有提示；不要在里面放密码。

---

## 8. 测试

| 层 | 内容 |
| --- | --- |
| `tests/fake_mdb.c`、`tests/fake_dsci.c` | 替身库：只实现代理用到的函数名和调用方式，回答几条固定语句。按不同前缀编译成几份，模拟"有列名 / 没列名""能中断 / 不能中断"等差异。 |
| `tests/agent_selftest.py` | 代理自测（管道直连）：协议、两类库、事务、分批、诊断、取消。CI 在 Python 2.7 / 3.6 / 3.13 下各跑一遍。 |
| `tests/harness.cjs`、`tests/fake_bastion.sh` | "假主机"：伪终端里的登录 shell + 带令牌的回环端口，形状与真实通道一致；假堡垒机菜单（输入 IP、选账号）。 |
| `onHostSession.test.cjs`、`dbBridgeOnHost.test.cjs` | 端到端：db.cfg 模式、指定模式、环境命令、堡垒机步骤、没有 Python、取消与重连、登录途中关闭、经 `dbBridge` 的事务与诊断、令牌校验。只在 Linux 上运行。 |
| `portForwardingBridge.shellRelay.test.cjs` | 令牌正确才开 shell；错误令牌不开；普通转发不带令牌。 |

---

## 9. 已知限制与后续

- **未在真实库上验证。** 函数签名已对照头文件；DMDB 客户端的头文件不在手头，那一部分按
  DSCI 的用法推断。第一次在真实主机上跑时如果代理异常退出（详情里出现
  `Segmentation fault`），需要按实际 ABI 调整。
- 同一连接在两个窗口同时打开未处理（与跳板隧道相同的已有限制）。
- altibase 等类型没有表结构树。
- 绑定参数、LOB 写入未实现；LOB 读取仅内存库原生通道支持。
- 可以考虑：登录步骤引用 SSH 主机上已保存的凭据（而不是明文）；在表单里用 `DIAG` 列出
  db.cfg 的库供选择。

/**
 * JDBC URLs carry their own host and port, so an SSH tunnel that rewrites
 * `target.host`/`target.port` would be ignored by the driver. These helpers
 * find the endpoint inside the URL text and swap it for the tunnel's.
 *
 * Supported shapes:
 *   jdbc:mysql://host:3306/db?x=1          (also mariadb, postgresql, dm, ...)
 *   jdbc:mysql://user:pw@h1:3306,h2:3306/db  (credentials, several hosts)
 *   jdbc:jtds:sqlserver://host:1433/db     (more than one sub-protocol)
 *   jdbc:sqlserver://host\INST:1433;databaseName=x
 *   jdbc:postgresql://[::1]:5432/db
 *   jdbc:oracle:thin:@host:1521:SID   /  @//host:1521/SERVICE  /  user/pw@host...
 *   jdbc:oracle:thin:@(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=h)(PORT=1521))...)
 *   jdbc:sybase:Tds:host:5000/db
 *
 * A URL that lists several hosts is tunneled to its first one.
 */
export interface JdbcEndpoint {
  host: string;
  port: number | null;
}

/** Ports drivers assume when the URL leaves the port out. */
const DEFAULT_PORTS: Record<string, number> = {
  mysql: 3306,
  mariadb: 3306,
  tidb: 4000,
  oceanbase: 2881,
  postgresql: 5432,
  opengauss: 5432,
  gaussdb: 8000,
  kingbase8: 54321,
  highgo: 5866,
  redshift: 5439,
  oracle: 1521,
  sqlserver: 1433,
  jtds: 1433,
  sybase: 5000,
  db2: 50000,
  dm: 5236,
  gbase: 5258,
  clickhouse: 8123,
  hive2: 10000,
  presto: 8080,
  trino: 8080,
};

interface Located {
  host: string;
  port: number | null;
  /** Rebuilds the URL around a new endpoint. */
  rewrite: (host: string, port: number) => string;
}

const HOST_PORT = /^(\[[^\]]+\]|[^/:;,@?\s()]+)(?::(\d+))?/;

function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/** SQL Server writes named instances as `host\INSTANCE`; only the host is dialed. */
function stripInstance(host: string): string {
  const slash = host.indexOf('\\');
  return slash > 0 ? host.slice(0, slash) : host;
}

function formatHost(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

function locateOracle(url: string): Located | null {
  // Credentials may sit between the driver type and `@`.
  const head = /^jdbc:oracle:[a-z0-9]+:[^@]*@/i.exec(url);
  if (!head) return null;
  const prefix = head[0];
  const rest = url.slice(prefix.length);

  if (rest.trimStart().startsWith('(')) {
    const host = /\(\s*HOST\s*=\s*([^)\s]+)\s*\)/i.exec(rest);
    if (!host) return null;
    const port = /\(\s*PORT\s*=\s*(\d+)\s*\)/i.exec(rest);
    return {
      host: host[1],
      port: port ? Number(port[1]) : null,
      // Every ADDRESS points at the tunnel: the other nodes are not reachable
      // from here anyway, and a leftover one would be dialed directly.
      rewrite: (newHost, newPort) => {
        let body = rest.replace(/\(\s*HOST\s*=\s*[^)]*\)/gi, `(HOST=${newHost})`);
        body = port
          ? body.replace(/\(\s*PORT\s*=\s*\d+\s*\)/gi, `(PORT=${newPort})`)
          : body.replace(/\(HOST=[^)]*\)/g, (match) => `${match}(PORT=${newPort})`);
        return `${prefix}${body}`;
      },
    };
  }

  const scheme = /^(?:[a-z]+:)?\/\//i.exec(rest);
  const lead = scheme ? scheme[0] : '';
  const endpoint = HOST_PORT.exec(rest.slice(lead.length));
  if (!endpoint) return null;
  const tail = rest.slice(lead.length + endpoint[0].length);
  return {
    host: stripBrackets(endpoint[1]),
    port: endpoint[2] ? Number(endpoint[2]) : null,
    rewrite: (newHost, newPort) => `${prefix}${lead}${formatHost(newHost)}:${newPort}${tail}`,
  };
}

function locateSybase(url: string): Located | null {
  const head = /^jdbc:sybase:tds:/i.exec(url);
  if (!head) return null;
  const endpoint = HOST_PORT.exec(url.slice(head[0].length));
  if (!endpoint) return null;
  const tail = url.slice(head[0].length + endpoint[0].length);
  return {
    host: stripBrackets(endpoint[1]),
    port: endpoint[2] ? Number(endpoint[2]) : null,
    rewrite: (newHost, newPort) => `${head[0]}${formatHost(newHost)}:${newPort}${tail}`,
  };
}

function locateVendor(url: string): Located | null {
  const head = /^jdbc:(?:[\w+.-]+:)+\/\//i.exec(url);
  if (!head) return null;
  const afterScheme = url.slice(head[0].length);
  const authorityEnd = afterScheme.search(/[/;?]/);
  const authority = authorityEnd === -1 ? afterScheme : afterScheme.slice(0, authorityEnd);
  const tail = authorityEnd === -1 ? '' : afterScheme.slice(authorityEnd);
  const at = authority.lastIndexOf('@');
  const credentials = at === -1 ? '' : authority.slice(0, at + 1);
  const hostList = authority.slice(credentials.length);
  // `h1:3306,h2:3306`: only the first host can go through one tunnel.
  const first = hostList.split(',')[0];
  const endpoint = /^(\[[^\]]+\]|[^:;,@?\s()]+)(?::(\d+))?$/.exec(first);
  if (!endpoint) return null;
  return {
    host: stripInstance(stripBrackets(endpoint[1])),
    port: endpoint[2] ? Number(endpoint[2]) : null,
    rewrite: (newHost, newPort) => `${head[0]}${credentials}${formatHost(newHost)}:${newPort}${tail}`,
  };
}

function locate(url: string): Located | null {
  if (!/^jdbc:/i.test(url)) return null;
  return locateOracle(url) ?? locateSybase(url) ?? locateVendor(url);
}

/** Reads the host/port a JDBC URL dials, or null when it has no TCP endpoint. */
export function parseJdbcEndpoint(url: string): JdbcEndpoint | null {
  const located = locate(url.trim());
  return located ? { host: located.host, port: located.port } : null;
}

/** The port a driver uses when the URL names none, when the vendor is known. */
export function jdbcDefaultPort(url: string): number | null {
  const parts = url.trim().toLowerCase().split(':');
  if (parts[0] !== 'jdbc') return null;
  for (const part of parts.slice(1, 3)) {
    const port = DEFAULT_PORTS[part];
    if (port) return port;
  }
  return null;
}

/**
 * Rewrites the endpoint of a JDBC URL to `host:port`, keeping every other part
 * (vendor, credentials, database path, parameters) untouched. Returns the
 * input unchanged when the URL has no recognizable endpoint.
 */
export function rewriteJdbcUrlEndpoint(url: string, host: string, port: number): string {
  const located = locate(url.trim());
  return located ? located.rewrite(host, port) : url;
}

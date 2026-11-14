import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.File;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.PrintWriter;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.Driver;
import java.sql.DriverManager;
import java.sql.DriverPropertyInfo;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Properties;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.logging.Logger;

/**
 * Minimal JDBC sidecar for Netcatty.
 *
 * Wire format (one request per line, tab separated, every value base64):
 *   <id> TAB <METHOD> TAB key=value TAB key=value ...
 *
 * Responses:
 *   OK   TAB <id> [TAB key=value]...
 *   ERR  TAB <id> TAB <message> [TAB <sqlState>]
 *   COLS TAB <id> TAB <nameB64>:<typeB64> ...
 *   ROW  TAB <id> TAB <cellB64> ...
 *   END  TAB <id>
 *
 * No third-party dependencies: the jar only needs a JRE to run.
 */
public final class NetcattyJdbcSidecar {
  private static final Map<String, Connection> CONNECTIONS = new ConcurrentHashMap<>();
  private static final Map<String, URLClassLoader> LOADERS = new ConcurrentHashMap<>();
  private static PrintWriter out;

  public static void main(String[] args) throws Exception {
    System.setProperty("file.encoding", "UTF-8");
    BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
    out = new PrintWriter(new BufferedWriter(new OutputStreamWriter(System.out, StandardCharsets.UTF_8)), true);
    emit("READY", "");
    String line;
    while ((line = in.readLine()) != null) {
      if (line.isEmpty()) continue;
      String[] parts = line.split("\t", -1);
      String id = parts.length > 0 ? parts[0] : "";
      String method = parts.length > 1 ? parts[1] : "";
      Map<String, String> params = new HashMap<>();
      for (int i = 2; i < parts.length; i++) {
        int eq = parts[i].indexOf('=');
        if (eq <= 0) continue;
        params.put(parts[i].substring(0, eq), decode(parts[i].substring(eq + 1)));
      }
      try {
        handle(id, method.toUpperCase(), params);
      } catch (Throwable error) {
        fail(id, error);
      }
      if ("SHUTDOWN".equalsIgnoreCase(method)) break;
    }
    closeAll();
    out.flush();
  }

  private static void handle(String id, String method, Map<String, String> params) throws Exception {
    switch (method) {
      case "PING":
        ok(id, Map.of("pong", "true"));
        return;
      case "CONNECT":
        connect(id, params);
        return;
      case "QUERY":
        query(id, params);
        return;
      case "UPDATE":
        update(id, params);
        return;
      case "METATABLES":
        metaTables(id, params);
        return;
      case "METACOLUMNS":
        metaColumns(id, params);
        return;
      case "BEGIN":
        // Statements run in auto-commit mode; a transaction is simply
        // auto-commit switched off until COMMIT / ROLLBACK.
        connection(params).setAutoCommit(false);
        ok(id, Map.of());
        return;
      case "COMMIT": {
        Connection connection = connection(params);
        if (!connection.getAutoCommit()) {
          connection.commit();
          connection.setAutoCommit(true);
        }
        ok(id, Map.of());
        return;
      }
      case "ROLLBACK": {
        Connection connection = connection(params);
        if (!connection.getAutoCommit()) {
          connection.rollback();
          connection.setAutoCommit(true);
        }
        ok(id, Map.of());
        return;
      }
      case "DISCONNECT": {
        Connection connection = CONNECTIONS.remove(params.getOrDefault("connId", ""));
        if (connection != null) connection.close();
        ok(id, Map.of());
        return;
      }
      case "SHUTDOWN":
        ok(id, Map.of());
        return;
      default:
        throw new IllegalArgumentException("Unknown method: " + method);
    }
  }

  private static void connect(String id, Map<String, String> params) throws Exception {
    String connId = params.getOrDefault("connId", "");
    String url = params.getOrDefault("url", "");
    String user = params.get("user");
    String password = params.get("password");
    String driverClass = params.get("driverClass");
    List<URL> urls = new ArrayList<>();
    String jars = params.getOrDefault("jars", "");
    if (!jars.isEmpty()) {
      for (String path : jars.split(File.pathSeparator)) {
        if (!path.isEmpty()) urls.add(new File(path).toURI().toURL());
      }
    }
    if (!urls.isEmpty()) {
      URLClassLoader loader = new URLClassLoader(urls.toArray(new URL[0]), ClassLoader.getSystemClassLoader());
      LOADERS.put(connId, loader);
      if (driverClass != null && !driverClass.isEmpty()) {
        Driver driver = (Driver) loader.loadClass(driverClass).getDeclaredConstructor().newInstance();
        DriverManager.registerDriver(new DriverShim(driver));
      } else {
        // ServiceLoader based discovery for bundled drivers inside user jars.
        java.util.ServiceLoader.load(Driver.class, loader)
            .forEach(driver -> {
              try {
                DriverManager.registerDriver(new DriverShim(driver));
              } catch (SQLException ignored) {
                // ignore broken drivers, keep the rest
              }
            });
      }
    }
    Properties properties = new Properties();
    if (user != null) properties.setProperty("user", user);
    if (password != null) properties.setProperty("password", password);
    // Extra driver properties (characterEncoding, useUnicode, ...) arrive with
    // a `prop.` prefix so they cannot collide with protocol keys.
    for (Map.Entry<String, String> entry : params.entrySet()) {
      String key = entry.getKey();
      if (key.startsWith("prop.") && key.length() > 5 && entry.getValue() != null) {
        properties.setProperty(key.substring(5), entry.getValue());
      }
    }
    // Unreachable hosts otherwise block the (single threaded) sidecar for as
    // long as the driver's own default, which can be minutes.
    DriverManager.setLoginTimeout(Math.max(1, parseInt(params.get("loginTimeoutSec"), 20)));
    Connection connection = DriverManager.getConnection(url, properties);
    connection.setAutoCommit(true);
    Connection previous = CONNECTIONS.put(connId, connection);
    if (previous != null) previous.close();
    Map<String, String> meta = new HashMap<>();
    try {
      meta.put("product", connection.getMetaData().getDatabaseProductName());
      meta.put("version", connection.getMetaData().getDatabaseProductVersion());
    } catch (SQLException ignored) {
      // metadata is best effort
    }
    ok(id, meta);
  }

  private static void query(String id, Map<String, String> params) throws Exception {
    Connection connection = connection(params);
    String sql = params.getOrDefault("sql", "");
    int maxRows = parseInt(params.get("maxRows"), 1000);
    Statement statement = createStreamingStatement(connection);
    try {
      applyQueryTimeout(statement, params);
      // Ask for rows in batches before executing. Set afterwards (as this
      // used to do) most drivers ignore it and read the whole result into
      // memory, which kills the JVM on a table with hundreds of millions of
      // rows even though only the first page is wanted.
      try { statement.setFetchSize(Math.min(maxRows + 1, 500)); } catch (Exception ignored) {}
      // Do not call setMaxRows: several drivers implement it by rewriting the
      // statement (trailing LIMIT), which breaks dialects that have no LIMIT.
      // The row cap is enforced while streaming instead.
      boolean hasResult = statement.execute(sql);
      if (!hasResult) {
        int updated = Math.max(statement.getUpdateCount(), 0);
        Map<String, String> tail = new HashMap<>();
        tail.put("rows", String.valueOf(updated));
        tail.put("update", "true");
        ok(id, tail);
        return;
      }
      ResultSet resultSet = statement.getResultSet();
      try {
        ResultSetMetaData meta = resultSet.getMetaData();
        int count = meta.getColumnCount();
        StringBuilder header = new StringBuilder("COLS\t").append(id);
        for (int i = 1; i <= count; i++) {
          header.append('\t').append(encode(meta.getColumnLabel(i))).append(':').append(encode(meta.getColumnTypeName(i)));
        }
        out.println(header);
        int rows = 0;
        boolean truncated = false;
        while (resultSet.next()) {
          if (rows >= maxRows) {
            truncated = true;
            // Stop the server sending the rest: closing a half-read result
            // makes some drivers read every remaining row first.
            try { statement.cancel(); } catch (Exception ignored) {}
            break;
          }
          StringBuilder row = new StringBuilder("ROW\t").append(id);
          for (int i = 1; i <= count; i++) {
            Object value = resultSet.getObject(i);
            row.append('\t').append(value == null ? "" : encode(stringify(value)));
          }
          out.println(row);
          rows++;
        }
        Map<String, String> tail = new HashMap<>();
        tail.put("rows", String.valueOf(rows));
        tail.put("truncated", truncated ? "true" : "false");
        ok(id, tail);
      } finally {
        // The answer is already sent. A cancelled statement may complain when
        // closed; that must not turn into a second, contradictory answer.
        try { resultSet.close(); } catch (Exception ignored) {}
      }
    } finally {
      try { statement.close(); } catch (Exception ignored) {}
    }
  }

  /** Forward-only and read-only is what lets drivers stream instead of buffering. */
  private static Statement createStreamingStatement(Connection connection) throws SQLException {
    try {
      return connection.createStatement(ResultSet.TYPE_FORWARD_ONLY, ResultSet.CONCUR_READ_ONLY);
    } catch (SQLException | RuntimeException unsupported) {
      return connection.createStatement();
    }
  }

  /**
   * Driver-side statement timeout: the driver cancels the statement itself and
   * the session survives, instead of Netcatty having to kill the JVM.
   */
  private static void applyQueryTimeout(Statement statement, Map<String, String> params) {
    int seconds = parseInt(params.get("timeoutSec"), 0);
    if (seconds <= 0) return;
    try {
      statement.setQueryTimeout(seconds);
    } catch (Exception ignored) {
      // Optional feature; the Node side still enforces its own deadline.
    }
  }

  private static final int MAX_SCHEMA_TABLES = 100000;

  private static void metaTables(String id, Map<String, String> params) throws Exception {
    Connection connection = connection(params);
    String schema = params.get("schema");
    StringBuilder header = new StringBuilder("COLS\t").append(id);
    for (String name : new String[] {"schema", "name", "type"}) {
      header.append('\t').append(encode(name)).append(':').append(encode("text"));
    }
    out.println(header);
    try (ResultSet resultSet =
        connection.getMetaData().getTables(null, schema, "%", new String[] {"TABLE", "VIEW"})) {
      int rows = 0;
      // Not a result set: the schema panel needs every table, or its search
      // cannot find the ones past the cut-off.
      while (resultSet.next() && rows < MAX_SCHEMA_TABLES) {
        out.println("ROW\t" + id
            + "\t" + encode(resultSet.getString("TABLE_SCHEM") == null ? "" : resultSet.getString("TABLE_SCHEM"))
            + "\t" + encode(resultSet.getString("TABLE_NAME"))
            + "\t" + encode("VIEW".equalsIgnoreCase(resultSet.getString("TABLE_TYPE")) ? "view" : "table"));
        rows++;
      }
      Map<String, String> tail = new HashMap<>();
      tail.put("rows", String.valueOf(rows));
      ok(id, tail);
    }
  }

  private static void metaColumns(String id, Map<String, String> params) throws Exception {
    Connection connection = connection(params);
    StringBuilder header = new StringBuilder("COLS\t").append(id);
    for (String name : new String[] {"name", "type", "nullable", "primaryKey"}) {
      header.append('\t').append(encode(name)).append(':').append(encode("text"));
    }
    out.println(header);
    Set<String> primaryKeys = new HashSet<>();
    try (ResultSet pk =
        connection.getMetaData().getPrimaryKeys(null, params.get("schema"), params.get("table"))) {
      while (pk.next()) {
        String column = pk.getString("COLUMN_NAME");
        if (column != null) primaryKeys.add(column.toUpperCase(Locale.ROOT));
      }
    }
    try (ResultSet resultSet =
        connection.getMetaData().getColumns(null, params.get("schema"), params.get("table"), "%")) {
      int rows = 0;
      while (resultSet.next() && rows < 2000) {
        boolean nullable = resultSet.getInt("NULLABLE") != java.sql.DatabaseMetaData.columnNoNulls;
        String typeName = resultSet.getString("TYPE_NAME");
        int size = resultSet.getInt("COLUMN_SIZE");
        int digits = resultSet.getInt("DECIMAL_DIGITS");
        if (size > 0 && typeName != null && typeName.matches("(?i).*(CHAR|BINARY|TEXT|DECIMAL|NUMERIC|NUMBER).*")) {
          boolean numeric = typeName.matches("(?i).*(DECIMAL|NUMERIC|NUMBER).*");
          typeName = typeName + "(" + size + (numeric && digits > 0 ? "," + digits : "") + ")";
        }
        String columnName = resultSet.getString("COLUMN_NAME");
        boolean isPk = columnName != null && primaryKeys.contains(columnName.toUpperCase(Locale.ROOT));
        out.println("ROW\t" + id
            + "\t" + encode(columnName)
            + "\t" + encode(typeName)
            + "\t" + encode(nullable ? "true" : "false")
            + "\t" + encode(isPk ? "true" : "false"));
        rows++;
      }
      ok(id, Map.of("rows", String.valueOf(rows)));
    }
  }

  private static void update(String id, Map<String, String> params) throws Exception {
    Connection connection = connection(params);
    try (Statement statement = connection.createStatement()) {
      applyQueryTimeout(statement, params);
      boolean hasResult = statement.execute(params.getOrDefault("sql", ""));
      Map<String, String> result = new HashMap<>();
      if (hasResult) {
        result.put("rows", "0");
      } else {
        result.put("rows", String.valueOf(Math.max(statement.getUpdateCount(), 0)));
      }
      ok(id, result);
    }
  }

  private static String stringify(Object value) {
    if (value instanceof byte[]) {
      return Base64.getEncoder().encodeToString((byte[]) value);
    }
    return String.valueOf(value);
  }

  private static Connection connection(Map<String, String> params) throws SQLException {
    Connection connection = CONNECTIONS.get(params.getOrDefault("connId", ""));
    if (connection == null) throw new SQLException("Connection is not open");
    return connection;
  }

  private static void closeAll() {
    for (Connection connection : CONNECTIONS.values()) {
      try {
        connection.close();
      } catch (SQLException ignored) {
        // best effort
      }
    }
    CONNECTIONS.clear();
  }

  private static int parseInt(String value, int fallback) {
    try {
      return value == null ? fallback : Integer.parseInt(value);
    } catch (NumberFormatException error) {
      return fallback;
    }
  }

  private static void ok(String id, Map<String, String> fields) {
    StringBuilder line = new StringBuilder("OK\t").append(id);
    for (Map.Entry<String, String> entry : fields.entrySet()) {
      line.append('\t').append(entry.getKey()).append('=').append(encode(entry.getValue()));
    }
    out.println(line);
  }

  private static void fail(String id, Throwable error) {
    String message = describe(error);
    String state = "";
    if (error instanceof SQLException) {
      SQLException sql = (SQLException) error;
      if (sql.getSQLState() != null) state = sql.getSQLState();
    }
    out.println("ERR\t" + id + "\t" + encode(message) + "\t" + encode(state));
  }

  /**
   * Drivers wrap the real reason ("Connection refused", "Unknown host", a
   * missing class) in a generic outer error, so the causes are appended.
   */
  static String describe(Throwable error) {
    StringBuilder text = new StringBuilder();
    java.util.Set<String> seen = new java.util.HashSet<>();
    Throwable current = error;
    for (int depth = 0; current != null && depth < 6; depth++) {
      String part = current.getMessage() == null ? current.toString() : current.getMessage();
      if (current instanceof ClassNotFoundException || current instanceof NoClassDefFoundError) {
        part = "class not found: " + part + " (a jar the driver depends on is missing from the driver files)";
      } else if (current instanceof java.net.UnknownHostException) {
        part = "unknown host: " + part;
      }
      if (seen.add(part) && text.indexOf(part) < 0) {
        if (text.length() > 0) text.append(" <- ");
        text.append(part);
      }
      Throwable next = current.getCause();
      if (next == current) break;
      current = next;
    }
    return text.toString();
  }

  private static void emit(String kind, String id) {
    out.println(kind + "\t" + id);
  }

  private static String encode(String value) {
    return Base64.getEncoder().encodeToString(value.getBytes(StandardCharsets.UTF_8));
  }

  private static String decode(String value) {
    if (value == null || value.isEmpty()) return "";
    return new String(Base64.getDecoder().decode(value), StandardCharsets.UTF_8);
  }

  /** Wraps a driver loaded from a user jar so DriverManager accepts it. */
  private static final class DriverShim implements Driver {
    private final Driver delegate;

    DriverShim(Driver delegate) {
      this.delegate = delegate;
    }

    public Connection connect(String url, Properties info) throws SQLException {
      return delegate.connect(url, info);
    }

    public boolean acceptsURL(String url) throws SQLException {
      return delegate.acceptsURL(url);
    }

    public DriverPropertyInfo[] getPropertyInfo(String url, Properties info) throws SQLException {
      return delegate.getPropertyInfo(url, info);
    }

    public int getMajorVersion() {
      return delegate.getMajorVersion();
    }

    public int getMinorVersion() {
      return delegate.getMinorVersion();
    }

    public boolean jdbcCompliant() {
      return delegate.jdbcCompliant();
    }

    public Logger getParentLogger() {
      return Logger.getGlobal();
    }
  }
}

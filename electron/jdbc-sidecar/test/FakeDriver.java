import java.io.IOException;
import java.io.UncheckedIOException;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.nio.file.StandardOpenOption;
import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.Driver;
import java.sql.DriverManager;
import java.sql.DriverPropertyInfo;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.SQLFeatureNotSupportedException;
import java.sql.Statement;
import java.util.Properties;
import java.util.logging.Logger;

/**
 * Test double for electron/bridges/jdbcSidecar.e2e.test.cjs (not shipped: the
 * packager excludes test/ folders). A JDBC driver whose connections record every
 * transaction-relevant call into the file named by the URL
 * (jdbc:fake:/path/to/events.log).
 *
 * Statement SQL understood by the fake:
 *   SELECT n     -> result set with n rows (id INT, name VARCHAR)
 *   SLEEP ms     -> blocks the statement for ms milliseconds
 *   FAIL         -> SQLException("boom", "42000")
 *   anything else-> update count 1
 */
public class FakeDriver implements Driver {
  private static final String PREFIX = "jdbc:fake:";

  static void log(String file, String event) {
    try {
      Files.writeString(Paths.get(file), event + "\n", StandardCharsets.UTF_8,
          StandardOpenOption.CREATE, StandardOpenOption.APPEND);
    } catch (IOException error) {
      throw new UncheckedIOException(error);
    }
  }

  private static Object common(Object proxy, String name, Object[] args, String label) {
    switch (name) {
      case "hashCode": return System.identityHashCode(proxy);
      case "equals": return proxy == args[0];
      case "toString": return label;
      case "isWrapperFor": return false;
      default: return null;
    }
  }

  @SuppressWarnings("unchecked")
  private static <T> T proxy(Class<T> type, InvocationHandler handler) {
    return (T) Proxy.newProxyInstance(FakeDriver.class.getClassLoader(), new Class<?>[] {type}, handler);
  }

  public boolean acceptsURL(String url) {
    return url != null && url.startsWith(PREFIX);
  }

  public Connection connect(String url, Properties info) throws SQLException {
    if (!acceptsURL(url)) return null;
    final String file = url.substring(PREFIX.length());
    log(file, "connect user=" + info.getProperty("user")
        + " loginTimeout=" + DriverManager.getLoginTimeout()
        + " charset=" + info.getProperty("characterEncoding"));
    final boolean[] autoCommit = {true};
    final boolean[] closed = {false};
    return proxy(Connection.class, (self, method, args) -> {
      String name = method.getName();
      switch (name) {
        case "setAutoCommit":
          autoCommit[0] = (Boolean) args[0];
          log(file, "setAutoCommit(" + args[0] + ")");
          return null;
        case "getAutoCommit": return autoCommit[0];
        case "commit": log(file, "commit"); return null;
        case "rollback": log(file, "rollback"); return null;
        case "close": closed[0] = true; log(file, "close"); return null;
        case "isClosed": return closed[0];
        case "createStatement": return statement(file);
        case "getMetaData": return metaData();
        default:
          Object common = common(self, name, args, "FakeConnection");
          if (common != null) return common;
          throw new SQLFeatureNotSupportedException("FakeConnection." + name);
      }
    });
  }

  private static Statement statement(String file) {
    final boolean[] hasResult = {false};
    final int[] rowCount = {0};
    return proxy(Statement.class, (self, method, args) -> {
      String name = method.getName();
      switch (name) {
        case "setQueryTimeout": log(file, "setQueryTimeout(" + args[0] + ")"); return null;
        case "setFetchSize": log(file, "setFetchSize(" + args[0] + ")"); return null;
        case "setMaxRows": log(file, "setMaxRows(" + args[0] + ")"); return null;
        case "cancel": log(file, "cancel"); return null;
        case "close": return null;
        case "execute": {
          String sql = (String) args[0];
          log(file, "execute(" + sql + ")");
          if (sql.startsWith("SLEEP ")) {
            Thread.sleep(Long.parseLong(sql.substring(6).trim()));
            return false;
          }
          if (sql.equals("FAIL")) throw new SQLException("boom", "42000");
          if (sql.startsWith("SELECT ")) {
            hasResult[0] = true;
            rowCount[0] = Integer.parseInt(sql.substring(7).trim());
            return true;
          }
          return false;
        }
        case "getUpdateCount": return hasResult[0] ? -1 : 1;
        case "getResultSet": return resultSet(rowCount[0]);
        default:
          Object common = common(self, name, args, "FakeStatement");
          if (common != null) return common;
          throw new SQLFeatureNotSupportedException("FakeStatement." + name);
      }
    });
  }

  private static ResultSet resultSet(int rows) {
    final int[] index = {-1};
    final ResultSetMetaData meta = proxy(ResultSetMetaData.class, (self, method, args) -> {
      switch (method.getName()) {
        case "getColumnCount": return 2;
        case "getColumnLabel":
        case "getColumnName": return ((Integer) args[0]) == 1 ? "id" : "name";
        case "getColumnTypeName": return ((Integer) args[0]) == 1 ? "INT" : "VARCHAR";
        default:
          Object common = common(self, method.getName(), args, "FakeResultSetMetaData");
          if (common != null) return common;
          throw new SQLFeatureNotSupportedException("FakeResultSetMetaData." + method.getName());
      }
    });
    return proxy(ResultSet.class, (self, method, args) -> {
      switch (method.getName()) {
        case "next": return ++index[0] < rows;
        case "getObject": return ((Integer) args[0]) == 1 ? (Object) (index[0] + 1) : "row" + (index[0] + 1);
        case "getMetaData": return meta;
        case "close": return null;
        default:
          Object common = common(self, method.getName(), args, "FakeResultSet");
          if (common != null) return common;
          throw new SQLFeatureNotSupportedException("FakeResultSet." + method.getName());
      }
    });
  }

  private static DatabaseMetaData metaData() {
    return proxy(DatabaseMetaData.class, (self, method, args) -> {
      switch (method.getName()) {
        case "getDatabaseProductName": return "FakeDB";
        case "getDatabaseProductVersion": return "1.0";
        default:
          Object common = common(self, method.getName(), args, "FakeDatabaseMetaData");
          if (common != null) return common;
          throw new SQLFeatureNotSupportedException("FakeDatabaseMetaData." + method.getName());
      }
    });
  }

  public DriverPropertyInfo[] getPropertyInfo(String url, Properties info) {
    return new DriverPropertyInfo[0];
  }

  public int getMajorVersion() {
    return 1;
  }

  public int getMinorVersion() {
    return 0;
  }

  public boolean jdbcCompliant() {
    return false;
  }

  public Logger getParentLogger() throws SQLFeatureNotSupportedException {
    throw new SQLFeatureNotSupportedException("no logger");
  }
}

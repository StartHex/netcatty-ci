import test from 'node:test';
import assert from 'node:assert/strict';

import { jdbcDefaultPort, parseJdbcEndpoint, rewriteJdbcUrlEndpoint } from './jdbcUrl.ts';

test('parseJdbcEndpoint reads vendor URLs and Oracle thin URLs', () => {
  assert.deepEqual(parseJdbcEndpoint('jdbc:mysql://10.0.0.5:3306/basdb?useSSL=false'), {
    host: '10.0.0.5',
    port: 3306,
  });
  assert.deepEqual(parseJdbcEndpoint('jdbc:dm://10.86.17.201:5236'), {
    host: '10.86.17.201',
    port: 5236,
  });
  assert.deepEqual(parseJdbcEndpoint('jdbc:oracle:thin:@10.1.1.1:1521:ORCL'), {
    host: '10.1.1.1',
    port: 1521,
  });
  assert.equal(parseJdbcEndpoint('jdbc:sqlite:/tmp/a.db'), null);
  assert.equal(parseJdbcEndpoint('not-a-url'), null);
});

test('rewriteJdbcUrlEndpoint keeps the rest of the URL intact', () => {
  assert.equal(
    rewriteJdbcUrlEndpoint('jdbc:mysql://10.0.0.5:3306/basdb?useSSL=false', '127.0.0.1', 54011),
    'jdbc:mysql://127.0.0.1:54011/basdb?useSSL=false',
  );
  assert.equal(
    rewriteJdbcUrlEndpoint('jdbc:sqlserver://db.local:1433;databaseName=x', '127.0.0.1', 54012),
    'jdbc:sqlserver://127.0.0.1:54012;databaseName=x',
  );
  assert.equal(
    rewriteJdbcUrlEndpoint('jdbc:oracle:thin:@10.1.1.1:1521:ORCL', '127.0.0.1', 54013),
    'jdbc:oracle:thin:@127.0.0.1:54013:ORCL',
  );
  assert.equal(
    rewriteJdbcUrlEndpoint('jdbc:oracle:thin:@//10.1.1.1:1521/SVC', '127.0.0.1', 54014),
    'jdbc:oracle:thin:@//127.0.0.1:54014/SVC',
  );
});

test('rewriteJdbcUrlEndpoint leaves URLs without an endpoint alone', () => {
  assert.equal(rewriteJdbcUrlEndpoint('jdbc:sqlite:/tmp/a.db', '127.0.0.1', 1), 'jdbc:sqlite:/tmp/a.db');
  assert.equal(rewriteJdbcUrlEndpoint('', '127.0.0.1', 1), '');
});

test('parseJdbcEndpoint handles the URL shapes drivers accept', () => {
  const cases: Array<[string, { host: string; port: number | null }]> = [
    ['jdbc:oracle:thin:@//10.1.1.1:1521/SVC', { host: '10.1.1.1', port: 1521 }],
    ['jdbc:oracle:thin:@10.1.1.1/SVC', { host: '10.1.1.1', port: null }],
    ['jdbc:oracle:thin:scott/tiger@10.1.1.1:1521:ORCL', { host: '10.1.1.1', port: 1521 }],
    ['jdbc:oracle:thin:@tcps://db.local:2484/SVC', { host: 'db.local', port: 2484 }],
    [
      'jdbc:oracle:thin:@(DESCRIPTION=(ADDRESS_LIST=(ADDRESS=(PROTOCOL=TCP)(HOST=10.2.2.2)(PORT=1522)))(CONNECT_DATA=(SERVICE_NAME=orcl)))',
      { host: '10.2.2.2', port: 1522 },
    ],
    ['jdbc:oracle:thin:@(description=(address=(host = rac-scan)(protocol=tcp)(port = 1521))(connect_data=(sid=x)))', { host: 'rac-scan', port: 1521 }],
    ['jdbc:jtds:sqlserver://10.3.3.3:1433/db', { host: '10.3.3.3', port: 1433 }],
    ['jdbc:sqlserver://sql01\\PROD:1433;databaseName=x', { host: 'sql01', port: 1433 }],
    ['jdbc:mysql://root:pw@10.0.0.5:3306/db', { host: '10.0.0.5', port: 3306 }],
    ['jdbc:mysql://h1:3306,h2:3307/db', { host: 'h1', port: 3306 }],
    ['jdbc:postgresql://[fd00::1]:5432/db', { host: 'fd00::1', port: 5432 }],
    ['jdbc:postgresql://db.local/app', { host: 'db.local', port: null }],
    ['jdbc:informix-sqli://ifx:9088/db:INFORMIXSERVER=x', { host: 'ifx', port: 9088 }],
    ['jdbc:sybase:Tds:10.4.4.4:5000/db', { host: '10.4.4.4', port: 5000 }],
    ['jdbc:clickhouse:http://ch:8123/default', { host: 'ch', port: 8123 }],
  ];
  for (const [url, expected] of cases) {
    assert.deepEqual(parseJdbcEndpoint(url), expected, url);
  }
  assert.equal(parseJdbcEndpoint('jdbc:sqlserver://;serverName=x;port=1433'), null);
  assert.equal(parseJdbcEndpoint('jdbc:h2:mem:test'), null);
});

test('rewriteJdbcUrlEndpoint points every supported shape at the tunnel', () => {
  const cases: Array<[string, string]> = [
    ['jdbc:oracle:thin:@10.1.1.1/SVC', 'jdbc:oracle:thin:@127.0.0.1:5000/SVC'],
    ['jdbc:oracle:thin:@10.1.1.1:ORCL', 'jdbc:oracle:thin:@127.0.0.1:5000:ORCL'],
    ['jdbc:oracle:thin:scott/tiger@10.1.1.1:1521:ORCL', 'jdbc:oracle:thin:scott/tiger@127.0.0.1:5000:ORCL'],
    [
      'jdbc:oracle:thin:@(DESCRIPTION=(ADDRESS_LIST=(ADDRESS=(PROTOCOL=TCP)(HOST=n1)(PORT=1521))(ADDRESS=(PROTOCOL=TCP)(HOST=n2)(PORT=1521)))(CONNECT_DATA=(SERVICE_NAME=orcl)))',
      'jdbc:oracle:thin:@(DESCRIPTION=(ADDRESS_LIST=(ADDRESS=(PROTOCOL=TCP)(HOST=127.0.0.1)(PORT=5000))(ADDRESS=(PROTOCOL=TCP)(HOST=127.0.0.1)(PORT=5000)))(CONNECT_DATA=(SERVICE_NAME=orcl)))',
    ],
    [
      'jdbc:oracle:thin:@(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=n1))(CONNECT_DATA=(SID=x)))',
      'jdbc:oracle:thin:@(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=127.0.0.1)(PORT=5000))(CONNECT_DATA=(SID=x)))',
    ],
    ['jdbc:jtds:sqlserver://10.3.3.3:1433/db', 'jdbc:jtds:sqlserver://127.0.0.1:5000/db'],
    ['jdbc:sqlserver://sql01\\PROD:1433;databaseName=x', 'jdbc:sqlserver://127.0.0.1:5000;databaseName=x'],
    ['jdbc:mysql://root:pw@10.0.0.5:3306/db?a=1', 'jdbc:mysql://root:pw@127.0.0.1:5000/db?a=1'],
    ['jdbc:mysql://h1:3306,h2:3307/db', 'jdbc:mysql://127.0.0.1:5000/db'],
    ['jdbc:postgresql://[fd00::1]:5432/db', 'jdbc:postgresql://127.0.0.1:5000/db'],
    ['jdbc:postgresql://db.local/app', 'jdbc:postgresql://127.0.0.1:5000/app'],
    ['jdbc:dm://10.86.17.201', 'jdbc:dm://127.0.0.1:5000'],
    ['jdbc:sybase:Tds:10.4.4.4:5000/db', 'jdbc:sybase:Tds:127.0.0.1:5000/db'],
  ];
  for (const [url, expected] of cases) {
    assert.equal(rewriteJdbcUrlEndpoint(url, '127.0.0.1', 5000), expected, url);
  }
});

test('jdbcDefaultPort knows the port a driver falls back to', () => {
  assert.equal(jdbcDefaultPort('jdbc:oracle:thin:@db/SVC'), 1521);
  assert.equal(jdbcDefaultPort('jdbc:mysql://db/app'), 3306);
  assert.equal(jdbcDefaultPort('jdbc:jtds:sqlserver://db/app'), 1433);
  assert.equal(jdbcDefaultPort('jdbc:dm://db'), 5236);
  assert.equal(jdbcDefaultPort('jdbc:unknownvendor://db'), null);
  assert.equal(jdbcDefaultPort('nope'), null);
});

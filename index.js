require('dotenv').config();
const {PerformanceObserver, performance} = require('perf_hooks');
const readline = require('readline');
const moment = require('moment');
const fs = require('fs');
const path = require('path');
const ConnectWise = require('connectwise-rest');
const sql = require('mssql');
const rl = readline.createInterface({input: process.stdin, output: process.stdout});
let stream;
let testType;
let testInterval;
let parallelism;
let pool;

const {
  DB_USER,
  DB_PASS,
  DB_NAME,
  DB_SERVER,
  API_PUBLIC,
  API_PRIVATE,
  API_COMPANY,
  API_SERVER,
} = process.env;

const cw = new ConnectWise({
  companyId: API_COMPANY,
  companyUrl: API_SERVER,
  publicKey: API_PUBLIC,
  privateKey: API_PRIVATE,
});

const sqlConfig = {
  user: DB_USER,
  password: DB_PASS,
  server: DB_SERVER,
  database: DB_NAME,
  options: {
    encrypt: false,
  },
};

async function connectSQL() {
  try {
    pool = await sql.connect(sqlConfig);
  } catch (err) {
    console.error('Error connecting to SQL Server.', err);
  }
}

async function withTest(test) {
  const now = Date.now();
  performance.mark(`start-test-${now}`);
  await test();
  performance.mark(`end-test-${now}`);
  performance.measure(`start-test-${now} to end-test-${now}`, `start-test-${now}`, `end-test-${now}`);
}

async function testSQL() {
  try {
    let result = await pool.request()
      .query('select count(*) as count from v_api_collection_service_ticket');
    console.log('result', result.recordset[0]);
  } catch (error) {
    console.log('error', (error && error.message) || (error && error.code));
  }
}

async function testAPI() {
  try {
    let result = await cw.ServiceDeskAPI.Tickets.getTicketsCount({});
    console.log('result', result);
  } catch (error) {
    console.log('error', (error && error.msg) || (error && error.code));
  }
}

function writeResult({duration}) {
  stream.write(`${moment().format('YYYY-MM-DD HH:mm:ss')},${testType},${duration}\r\n`);
}

const obs = new PerformanceObserver((list, observer) => {
  const {duration} = list.getEntries()[0];
  console.log(moment().format('YYYY-MM-DD HH:mm:ss'), 'duration', duration, 'ms');
  writeResult({duration});
});
obs.observe({entryTypes: ['measure'], buffered: true});

process.on('unhandledRejection', (error, promise) => {
  console.log(error, promise);
});

function finish() {
  if (pool) {
    pool.close();
  }
  stream.end();
  obs.disconnect();
  process.exit(0);
}

process.on('SIGINT', finish);
process.on('SIGTERM', finish);
process.on('SIGHUP', finish);
process.on('SIGBREAK', finish);


rl.question('Select test type:\r\n[1] - MSSQL\r\n2 - CWAPI\r\n>', (ans) => {
  switch (ans) {
    case '1':
      testType = 'MSSQL';
      break;
    case '2':
      testType = 'CWAPI';
      break;
    default:
      testType = 'MSSQL';
  }
  rl.question('Time between queries [15]s:\r\n>', (ans) => {
    const parsed = parseInt(ans, 10);
    if (Number.isNaN(parsed)) {
      testInterval = 15 * 1000;
    } else {
      testInterval = parsed * 1000;
    }
    rl.question('Parallelism [1]:\r\n>', (ans) => {
      const parsed = parseInt(ans, 10);
      if (Number.isNaN(parsed)) {
        parallelism = 1;
      } else {
        parallelism = parsed;
      }
      rl.close();
      start();
    });
  });
});


async function start() {
  console.log('Starting tests.  Ctrl-C to exit.');
  console.log(`Test Settings:\r\nTest: ${testType}\r\nInterval: ${testInterval / 1000}s\r\nParallelism: ${parallelism}`);
  stream = fs.createWriteStream(
    path.join(
      __dirname,
      `results-${moment().format('YYYY-MM-DD HH_mm_ss')}-${testType}-int_${testInterval / 1000}-p${parallelism}.csv`), {
      flags: 'a',
    },
  );
  stream.write('date,test_type,duration\r\n');

  if (testType === 'MSSQL') {
    await connectSQL();
    await Promise.all([...new Array(parallelism)].map(() => withTest(testSQL)));
  } else {
    await Promise.all([...new Array(parallelism)].map(() => withTest(testAPI)));
  }

  // start loop
  setInterval(() => {
    if (testType === 'CWAPI') {
      Promise.all([...new Array(parallelism)].map(() => withTest(testAPI)));
    } else {
      Promise.all([...new Array(parallelism)].map(() => withTest(testSQL)));
    }
  }, testInterval);
}

import http from 'k6/http';
import { check } from 'k6';
import { SharedArray } from 'k6/data';
import { Counter, Rate } from 'k6/metrics';
import exec from 'k6/execution';

// ===================== 手动配置区：每次压测前主要改这里 =====================
// !!! 重点：新建培训班后，把这里改成新的培训班 ID
const TRAINING_ID = 38;

// 接口服务地址
const BASE_URL = 'http://10.21.70.227:9007';

// token 文件路径：token.csv 和本脚本放在同一个目录，所以这里用相对路径
const TOKEN_CSV_PATH = './token500.csv';

// 并发用户数：当前 token.csv 已验证 66 个有效 token
const VUS = 500;

// 每个 token 请求次数：报名压测建议保持 1，避免第二次请求变成“重复报名”
const ITERATIONS_PER_TOKEN = 1;

// 单次压测最长执行时间
const MAX_DURATION = '2m';

// 租户 ID：从抓包看到当前系统为 1
const TENANT_ID = '1';
// ======================================================================

// 业务统计指标：用于区分“HTTP成功”和“报名业务成功”
const registerSuccessCount = new Counter('register_success_count');
const duplicateRegisterCount = new Counter('duplicate_register_count');
const unauthorizedCount = new Counter('unauthorized_count');
const otherFailureCount = new Counter('other_failure_count');
const registerSuccessRate = new Rate('register_success_rate');

export const options = {
  scenarios: {
    registration_500_concurrent: {
      // shared-iterations：66 个并发用户共同完成 66 次请求
      executor: 'shared-iterations',
      vus: VUS,
      iterations: VUS * ITERATIONS_PER_TOKEN,
      maxDuration: MAX_DURATION,
    },
  },
  thresholds: {
    // 阈值只用于压测结果判断，不会影响请求发送
    http_req_failed: ['rate<0.05'],
    http_req_duration: ['p(95)<3000'],
    register_success_rate: ['rate>0.90'],
  },
  // 让汇总数据里包含 JMeter 聚合报告常看的 90/95/99 线
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
};

// SharedArray 只在初始化时读取一次 token.csv，避免每个并发用户重复读文件
const tokens = new SharedArray('tokens', function () {
  return open(TOKEN_CSV_PATH)
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => line.split(',')[0].trim())
    .filter((token) => token !== '');
});

export function setup() {
  // 启动前先检查 token 数量，避免并发数大于 token 数导致 token 被重复使用
  if (tokens.length < VUS) {
    throw new Error(`token 数量不足：当前 ${tokens.length} 个，配置并发 ${VUS} 个`);
  }

  console.log(`报名接口压测准备完成：trainingId=${TRAINING_ID}, 并发=${VUS}, token数量=${tokens.length}`);
}

export default function () {
  // 使用全局迭代序号取 token，确保 66 次请求分别使用 66 个不同 token
  // 注意：不要用 __ITER，它是每个 VU 自己的迭代序号，并发时会重复
  const tokenIndex = exec.scenario.iterationInTest % tokens.length;
  const token = tokens[tokenIndex];
  const url = `${BASE_URL}/training/app-api/training/registration/create`;
  const payload = JSON.stringify({
    trainingId: TRAINING_ID,
  });

  const params = {
    headers: {
      'Content-Type': 'application/json',
      'tenant-id': TENANT_ID,
      Authorization: `Bearer ${token}`,
    },
    tags: {
      // tags 方便后续按接口、trainingId 过滤统计
      api: 'registration_create',
      trainingId: String(TRAINING_ID),
    },
  };

  const res = http.post(url, payload, params);

  // 报名接口正常返回 JSON；如果返回非 JSON，就记录为 parse_error，便于定位异常
  let body = {};
  try {
    body = res.json();
  } catch (e) {
    body = {
      code: 'parse_error',
      msg: res.body,
    };
  }

  const isSuccess = res.status === 200 && body.code === 0;
  const isDuplicate = res.status === 200 && body.code === 1030002001;
  const isUnauthorized = res.status === 200 && body.code === 401;

  // 按业务返回码分类统计，避免只看 HTTP 200 误判为报名成功
  if (isSuccess) {
    registerSuccessCount.add(1);
    registerSuccessRate.add(true);
  } else {
    registerSuccessRate.add(false);

    if (isDuplicate) {
      duplicateRegisterCount.add(1);
    } else if (isUnauthorized) {
      unauthorizedCount.add(1);
    } else {
      otherFailureCount.add(1);
      console.error(`报名失败：status=${res.status}, code=${body.code}, msg=${body.msg}`);
    }
  }

  check(res, {
    'HTTP 200': (r) => r.status === 200,
    '报名成功 code=0': () => isSuccess,
  });
}

function metricValue(data, metricName, valueName, defaultValue = 0) {
  return data.metrics[metricName]?.values?.[valueName] ?? defaultValue;
}

function fixed(value, digits = 2) {
  return Number(value || 0).toFixed(digits);
}

// 自定义压测结束摘要：
// 1. 控制台输出一份 JMeter 聚合报告风格的字段
// 2. 落地 registration_66_summary.json，方便后续做测试报告
export function handleSummary(data) {
  const durationSeconds = (data.state?.testRunDurationMs || 0) / 1000;
  const samples = metricValue(data, 'http_reqs', 'count');
  const errorRate = metricValue(data, 'http_req_failed', 'rate');

  const jmeterLike = {
    Label: '报名接口 /training/registration/create',
    Samples: samples,
    Average: metricValue(data, 'http_req_duration', 'avg'),
    Median: metricValue(data, 'http_req_duration', 'med'),
    Line90: metricValue(data, 'http_req_duration', 'p(90)'),
    Line95: metricValue(data, 'http_req_duration', 'p(95)'),
    Line99: metricValue(data, 'http_req_duration', 'p(99)'),
    Min: metricValue(data, 'http_req_duration', 'min'),
    Max: metricValue(data, 'http_req_duration', 'max'),
    ErrorPercent: errorRate * 100,
    Throughput: durationSeconds > 0 ? samples / durationSeconds : 0,
    ReceivedKBPerSec: metricValue(data, 'data_received', 'rate') / 1024,
    SentKBPerSec: metricValue(data, 'data_sent', 'rate') / 1024,
  };

  const businessSummary = {
    trainingId: TRAINING_ID,
    vus: VUS,
    tokenFile: TOKEN_CSV_PATH,
    registerSuccess: metricValue(data, 'register_success_count', 'count'),
    duplicateRegister: metricValue(data, 'duplicate_register_count', 'count'),
    unauthorized: metricValue(data, 'unauthorized_count', 'count'),
    otherFailure: metricValue(data, 'other_failure_count', 'count'),
    registerSuccessRate: metricValue(data, 'register_success_rate', 'rate') * 100,
  };

  const summary = {
    config: {
      trainingId: TRAINING_ID,
      vus: VUS,
      iterations: VUS * ITERATIONS_PER_TOKEN,
      tokenFile: TOKEN_CSV_PATH,
    },
    jmeterLike,
    businessSummary,
  };

  return {
    stdout: [
      '',
      '================ JMeter聚合报告参考字段 ================',
      `Label: ${jmeterLike.Label}`,
      `# Samples: ${jmeterLike.Samples}`,
      `Average(ms): ${fixed(jmeterLike.Average)}`,
      `Median(ms): ${fixed(jmeterLike.Median)}`,
      `90% Line(ms): ${fixed(jmeterLike.Line90)}`,
      `95% Line(ms): ${fixed(jmeterLike.Line95)}`,
      `99% Line(ms): ${fixed(jmeterLike.Line99)}`,
      `Min(ms): ${fixed(jmeterLike.Min)}`,
      `Max(ms): ${fixed(jmeterLike.Max)}`,
      `Error %: ${fixed(jmeterLike.ErrorPercent)}%`,
      `Throughput(req/s): ${fixed(jmeterLike.Throughput)}`,
      `Received KB/sec: ${fixed(jmeterLike.ReceivedKBPerSec)}`,
      `Sent KB/sec: ${fixed(jmeterLike.SentKBPerSec)}`,
      '================ 报名接口业务统计 ================',
      `trainingId: ${businessSummary.trainingId}`,
      `并发 VUS: ${businessSummary.vus}`,
      `报名成功: ${businessSummary.registerSuccess}`,
      `重复报名: ${businessSummary.duplicateRegister}`,
      `未登录/token失效: ${businessSummary.unauthorized}`,
      `其他失败: ${businessSummary.otherFailure}`,
      `报名成功率: ${fixed(businessSummary.registerSuccessRate)}%`,
      '=================================================',
      '',
    ].join('\n'),
    'registration_500_summary.json': JSON.stringify(summary, null, 2),
  };
}

import http from 'k6/http';
import { check } from 'k6';
import { SharedArray } from 'k6/data';
import { Counter, Rate, Trend } from 'k6/metrics';
import exec from 'k6/execution';

const BASE_URL = __ENV.BASE_URL || 'http://10.21.70.235/training';
const TOKEN_FILE = __ENV.TOKEN_FILE || './0812_500.csv';
const TRAINING_ID_49 = Number(__ENV.TRAINING_ID_49 || 49);
const TRAINING_ID_50 = Number(__ENV.TRAINING_ID_50 || 50);
const PAGE_NO = Number(__ENV.PAGE_NO || 1);
const PAGE_SIZE = Number(__ENV.PAGE_SIZE || 5);
const NOTICE_STATUS = __ENV.NOTICE_STATUS || 'published';

const STAGE1_VUS = Number(__ENV.STAGE1_VUS || 20);
const STAGE1_DURATION = __ENV.STAGE1_DURATION || '30s';
const STAGE2_VUS = Number(__ENV.STAGE2_VUS || 50);
const STAGE2_DURATION = __ENV.STAGE2_DURATION || '1m';
const RAMP_UP_DURATION = __ENV.RAMP_UP_DURATION || '5s';
const TRANSITION_DURATION = __ENV.TRANSITION_DURATION || '5s';
const P95_MS = Number(__ENV.P95_MS || 3000);
const TENANT_ID = __ENV.TENANT_ID || '1';

const apis = [
  {
    key: 'notice_page',
    label: '首页通知列表',
    url: () => `${BASE_URL}/app-api/training/notice/page?pageNo=${PAGE_NO}&pageSize=${PAGE_SIZE}&status=${NOTICE_STATUS}`,
    validate: (res, body) => res.status === 200 && body.code === 0 && body.data && Array.isArray(body.data.list),
  },
  {
    key: 'user_info',
    label: '用户信息',
    url: () => `${BASE_URL}/app-api/member/user/info`,
    validate: (res, body) => res.status === 200 && body.code === 0 && body.data,
  },
  {
    key: 'message_unread_count',
    label: '消息未读数',
    url: () => `${BASE_URL}/app-api/training/message/unread-count`,
    validate: (res, body) => res.status === 200 && body.code === 0,
  },
  {
    key: 'my_record_page',
    label: '我的培训记录列表',
    url: () => `${BASE_URL}/app-api/training/class/my-record-page?pageNo=${PAGE_NO}&pageSize=${PAGE_SIZE}`,
    validate: (res, body) => res.status === 200 && body.code === 0 && body.data && Array.isArray(body.data.list),
  },
  {
    key: 'my_overview',
    label: '我的培训总览',
    url: () => `${BASE_URL}/app-api/training/class/my-overview`,
    validate: (res, body) => res.status === 200 && body.code === 0 && body.data,
  },
  {
    key: 'training49_my_detail',
    label: '培训49 我的培训详情',
    url: () => `${BASE_URL}/app-api/training/class/my-training-detail?trainingId=${TRAINING_ID_49}`,
    validate: (res, body) => res.status === 200 && body.code === 0 && body.data,
  },
  {
    key: 'training49_detail',
    label: '培训49 详情',
    url: () => `${BASE_URL}/app-api/training/class/detail?id=${TRAINING_ID_49}`,
    validate: (res, body) => res.status === 200 && body.code === 0 && body.data,
  },
  {
    key: 'training49_registration',
    label: '培训49 报名记录详情',
    url: () => `${BASE_URL}/app-api/training/registration/my-get?trainingId=${TRAINING_ID_49}`,
    validate: (res, body) => res.status === 200 && body.code === 0 && body.data,
  },
  {
    key: 'training50_my_detail',
    label: '培训50 我的培训详情',
    url: () => `${BASE_URL}/app-api/training/class/my-training-detail?trainingId=${TRAINING_ID_50}`,
    validate: (res, body) => res.status === 200 && body.code === 0 && body.data,
  },
  {
    key: 'training50_detail',
    label: '培训50 详情',
    url: () => `${BASE_URL}/app-api/training/class/detail?id=${TRAINING_ID_50}`,
    validate: (res, body) => res.status === 200 && body.code === 0 && body.data,
  },
  {
    key: 'training50_registration',
    label: '培训50 报名记录详情',
    url: () => `${BASE_URL}/app-api/training/registration/my-get?trainingId=${TRAINING_ID_50}`,
    validate: (res, body) => res.status === 200 && body.code === 0 && body.data,
  },
];

const totalSuccessCount = new Counter('mixed_total_success_count');
const totalFailureCount = new Counter('mixed_total_failure_count');
const unauthorizedCount = new Counter('mixed_unauthorized_count');
const mixedSuccessRate = new Rate('mixed_success_rate');

const apiMetrics = {};
for (const api of apis) {
  apiMetrics[api.key] = {
    success: new Counter(`${api.key}_success_count`),
    failure: new Counter(`${api.key}_failure_count`),
    successRate: new Rate(`${api.key}_success_rate`),
    duration: new Trend(`${api.key}_duration`, true),
  };
}

const tokens = new SharedArray('tokens', () => readTokens(TOKEN_FILE));

export const options = {
  scenarios: {
    training_mixed_apis_49_50_local: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: RAMP_UP_DURATION, target: STAGE1_VUS },
        { duration: STAGE1_DURATION, target: STAGE1_VUS },
        { duration: TRANSITION_DURATION, target: STAGE2_VUS },
        { duration: STAGE2_DURATION, target: STAGE2_VUS },
      ],
      gracefulRampDown: '5s',
      gracefulStop: '30s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.05'],
    http_req_duration: [`p(95)<${P95_MS}`],
    mixed_success_rate: ['rate>=0.95'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
};

export function setup() {
  if (tokens.length === 0) {
    throw new Error(`token 文件为空或读取失败: ${TOKEN_FILE}`);
  }

  const maxVus = Math.max(STAGE1_VUS, STAGE2_VUS);
  if (tokens.length < maxVus) {
    console.warn(`token 数量 ${tokens.length} 小于峰值并发 ${maxVus}，会循环复用 token`);
  }

  console.log(
    [
      '49 + 50 混合压测准备完成',
      `baseUrl=${BASE_URL}`,
      `training49=${TRAINING_ID_49}`,
      `training50=${TRAINING_ID_50}`,
      `tokenFile=${TOKEN_FILE}`,
      `tokenCount=${tokens.length}`,
      `阶段1=${STAGE1_VUS}/${STAGE1_DURATION}`,
      `阶段2=${STAGE2_VUS}/${STAGE2_DURATION}`,
      `接口数=${apis.length}`,
    ].join(', ')
  );
}

export default function () {
  const iteration = exec.scenario.iterationInTest;
  const api = apis[iteration % apis.length];
  const token = tokens[(exec.vu.idInTest - 1) % tokens.length];

  const params = {
    headers: {
      'Content-Type': 'application/json',
      'tenant-id': TENANT_ID,
      Authorization: token,
    },
    tags: {
      api: api.key,
      apiName: api.label,
    },
  };

  const res = http.get(api.url(), params);
  apiMetrics[api.key].duration.add(res.timings.duration);

  let body = {};
  try {
    body = res.json();
  } catch (e) {
    body = { code: 'parse_error', msg: res.error || res.body };
  }

  const isSuccess = Boolean(api.validate(res, body));
  const isUnauthorized = res.status === 200 && Number(body.code) === 401;

  mixedSuccessRate.add(isSuccess);
  apiMetrics[api.key].successRate.add(isSuccess);

  if (isSuccess) {
    totalSuccessCount.add(1);
    apiMetrics[api.key].success.add(1);
  } else {
    totalFailureCount.add(1);
    apiMetrics[api.key].failure.add(1);
    if (isUnauthorized) {
      unauthorizedCount.add(1);
    }
    console.error(`${api.label} 失败: status=${res.status}, code=${body.code}, msg=${body.msg || ''}`);
  }

  check(res, {
    'HTTP 200': (r) => r.status === 200,
    '业务成功 code=0': () => isSuccess,
  });
}

function readTokens(path) {
  return open(path)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && line !== 'access_token')
    .map((line) => line.split(',')[0].trim())
    .filter((token) => token !== '');
}

function metricValue(data, metricName, valueName, defaultValue = 0) {
  return data.metrics[metricName]?.values?.[valueName] ?? defaultValue;
}

function fixed(value, digits = 2) {
  return Number(value || 0).toFixed(digits);
}

function apiSummaryLine(data, api) {
  const success = metricValue(data, `${api.key}_success_count`, 'count');
  const failure = metricValue(data, `${api.key}_failure_count`, 'count');
  const total = success + failure;
  const rate = total > 0 ? (success / total) * 100 : 0;
  const avg = metricValue(data, `${api.key}_duration`, 'avg');
  const p90 = metricValue(data, `${api.key}_duration`, 'p(90)');
  const p95 = metricValue(data, `${api.key}_duration`, 'p(95)');
  return `${api.label}: 请求=${total}, 成功=${success}, 失败=${failure}, 成功率=${fixed(rate)}%, 平均=${fixed(avg)}ms, P90=${fixed(p90)}ms, P95=${fixed(p95)}ms`;
}

export function handleSummary(data) {
  const durationSeconds = (data.state?.testRunDurationMs || 0) / 1000;
  const samples = metricValue(data, 'http_reqs', 'count');
  const errorRate = metricValue(data, 'http_req_failed', 'rate') * 100;
  const totalSuccess = metricValue(data, 'mixed_total_success_count', 'count');
  const totalFailure = metricValue(data, 'mixed_total_failure_count', 'count');
  const successRate = metricValue(data, 'mixed_success_rate', 'rate') * 100;
  const avgVusPerApiStage1 = STAGE1_VUS / apis.length;
  const avgVusPerApiStage2 = STAGE2_VUS / apis.length;

  const endpointSummaries = {};
  for (const api of apis) {
    const success = metricValue(data, `${api.key}_success_count`, 'count');
    const failure = metricValue(data, `${api.key}_failure_count`, 'count');
    endpointSummaries[api.key] = {
      name: api.label,
      url: api.url(),
      approxVusStage1: avgVusPerApiStage1,
      approxVusStage2: avgVusPerApiStage2,
      requests: success + failure,
      success,
      failure,
      successRate: success + failure > 0 ? (success / (success + failure)) * 100 : 0,
      avgMs: metricValue(data, `${api.key}_duration`, 'avg'),
      medianMs: metricValue(data, `${api.key}_duration`, 'med'),
      p90Ms: metricValue(data, `${api.key}_duration`, 'p(90)'),
      p95Ms: metricValue(data, `${api.key}_duration`, 'p(95)'),
      p99Ms: metricValue(data, `${api.key}_duration`, 'p(99)'),
    };
  }

  const summary = {
    config: {
      baseUrl: BASE_URL,
      trainingId49: TRAINING_ID_49,
      trainingId50: TRAINING_ID_50,
      tokenFile: TOKEN_FILE,
      tokenCount: tokens.length,
      stage1Vus: STAGE1_VUS,
      stage1Duration: STAGE1_DURATION,
      stage2Vus: STAGE2_VUS,
      stage2Duration: STAGE2_DURATION,
      apiCount: apis.length,
      approxVusPerApiStage1: avgVusPerApiStage1,
      approxVusPerApiStage2: avgVusPerApiStage2,
    },
    result: {
      requests: samples,
      averageMs: metricValue(data, 'http_req_duration', 'avg'),
      medianMs: metricValue(data, 'http_req_duration', 'med'),
      p90Ms: metricValue(data, 'http_req_duration', 'p(90)'),
      p95Ms: metricValue(data, 'http_req_duration', 'p(95)'),
      p99Ms: metricValue(data, 'http_req_duration', 'p(99)'),
      minMs: metricValue(data, 'http_req_duration', 'min'),
      maxMs: metricValue(data, 'http_req_duration', 'max'),
      errorPercent: errorRate,
      throughput: durationSeconds > 0 ? samples / durationSeconds : 0,
      receivedKBPerSec: metricValue(data, 'data_received', 'rate') / 1024,
      sentKBPerSec: metricValue(data, 'data_sent', 'rate') / 1024,
      success: totalSuccess,
      failure: totalFailure,
      unauthorized: metricValue(data, 'mixed_unauthorized_count', 'count'),
      successRate,
    },
    endpoints: endpointSummaries,
  };

  return {
    stdout: [
      '',
      '================ 49 + 50 混合压测汇总 ================',
      `接口数量: ${apis.length}`,
      `请求总数: ${samples}`,
      `平均响应(ms): ${fixed(summary.result.averageMs)}`,
      `P90(ms): ${fixed(summary.result.p90Ms)}`,
      `P95(ms): ${fixed(summary.result.p95Ms)}`,
      `P99(ms): ${fixed(summary.result.p99Ms)}`,
      `错误率: ${fixed(summary.result.errorPercent)}%`,
      `吞吐(req/s): ${fixed(summary.result.throughput)}`,
      `token文件: ${TOKEN_FILE}`,
      `token数量: ${tokens.length}`,
      `培训ID: ${TRAINING_ID_49} + ${TRAINING_ID_50}`,
      `阶段1并发/时长: ${STAGE1_VUS} / ${STAGE1_DURATION}`,
      `阶段2并发/时长: ${STAGE2_VUS} / ${STAGE2_DURATION}`,
      `成功数: ${totalSuccess}`,
      `失败数: ${totalFailure}`,
      `未授权数: ${summary.result.unauthorized}`,
      `成功率: ${fixed(successRate)}%`,
      '---------------- 单接口明细 ----------------',
      ...apis.map((api) => apiSummaryLine(data, api)),
      '======================================================',
      '',
    ].join('\n'),
    './training_mixed_apis_49_50_local_summary.json': JSON.stringify(summary, null, 2),
  };
}

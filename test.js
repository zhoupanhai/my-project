import http from 'k6/http';
import { check } from 'k6';
import { SharedArray } from 'k6/data';
import { Counter, Rate } from 'k6/metrics';

const loginUserCount = 200;
const studyRounds = 2;

const loginSuccessCount = new Counter('login_success_count');
const loginFailureCount = new Counter('login_failure_count');
const studySuccessCount = new Counter('study_success_count');
const studyFailureCount = new Counter('study_failure_count');
const studySuccessRate = new Rate('study_success_rate');

export const options = {
    scenarios: {
        study_only: {
            executor: 'shared-iterations',
            vus: 200,
            iterations: loginUserCount * studyRounds,
            maxDuration: '2m',
        },
    },
};

const users = new SharedArray('users', function () {
    return open('./2100_users.csv')
        .split('\n')
        .slice(1)
        .filter(line => line.trim() !== '')
        .map(line => {
            const [telephone, password] = line.split(',');
            return {
                telephone: telephone.trim(),
                password: password.trim(),
            };
        });
});

export function setup() {
    const loginUsers = users.slice(0, loginUserCount);
    const sessions = [];

    for (const user of loginUsers) {
        const loginPayload =
            `telephone=${user.telephone}` +
            `&password=${user.password}` +
            `&code=` +
            `&deviceType=5` +
            `&deviceToken=` +
            `&flg=2` +
            `&inviterId=0`;

        const loginRes = http.post(
            'https://b2bdev.lzdxedu.com/user/h5/login',
            loginPayload,
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
            }
        );

        const loginOk = check(loginRes, {
            'login success': (r) => {
                try {
                    const body = JSON.parse(r.body);
                    return r.status === 200 && body.data && body.data.access_token && body.data.userId;
                } catch (e) {
                    return false;
                }
            },
        });

        if (!loginOk) {
            loginFailureCount.add(1);
            console.error(`login failed: ${user.telephone}`);
            continue;
        }

        const loginJson = JSON.parse(loginRes.body);
        loginSuccessCount.add(1);
        sessions.push({
            telephone: user.telephone,
            token: loginJson.data.access_token,
            userId: loginJson.data.userId,
        });
    }

    if (sessions.length === 0) {
        throw new Error('no valid login sessions available for study pressure test');
    }

    console.log(`login complete, sessions: ${sessions.length}`);
    return sessions;
}

export default function (sessions) {
    const session = sessions[__ITER % sessions.length];
    const studyUrl = `https://b2bdev.lzdxedu.com/producer/study/h5/addRecord?access_token=${session.token}`;

    const studyPayload = JSON.stringify({
        tarUserId: session.userId,
        tarCompanyId: 9993,
        viewType: 6,
        planId: '22304',
        productId: '65',
        contentId: 555,
        liveId: 0,
        viewTime: 2,
        endTime: 2,
        cacheSize: 0,
        cacheTime: 0,
        videoFormat: 3,
        videoSize: 30,
        videoTime: 214,
        verifyTime: Date.now(),
        orderId: null,
    });

    const studyRes = http.post(studyUrl, studyPayload, {
        headers: {
            'Content-Type': 'application/json',
        },
    });

    const studyOk = check(studyRes, {
        'study success': (r) => r.status === 200,
    });

    studySuccessRate.add(studyOk);

    if (studyOk) {
        studySuccessCount.add(1);
    } else {
        studyFailureCount.add(1);
        console.error(`study failed: ${session.telephone}, status: ${studyRes.status}`);
    }
}

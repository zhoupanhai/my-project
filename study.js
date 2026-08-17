import http from 'k6/http';
import { sleep } from 'k6';
import { SharedArray } from 'k6/data';

export const options = {
    vus: 10,
    duration: '10s',
};

// ✅ 读取 CSV
const users = new SharedArray('users', function () {
    return open('./2100_users.csv')
        .split('\n')
        .slice(1)
        .filter(line => line.trim() !== '')
        .map(line => {
            let [telephone, password] = line.split(',');
            return {
                telephone: telephone.trim(),
                password: password.trim()
            };
        });
});

export default function () {

    let user = users[__ITER % users.length];

    // ========================
    // 1️⃣ 登录接口
    // ========================
    let loginUrl = "https://b2bdev.lzdxedu.com/user/h5/login";

    let loginPayload = {
        telephone: user.telephone,
        password: user.password,
        code: "",
        deviceType: "5",
        deviceToken: "",
        flg: "2",
        inviterId: "0"
    };

    let loginRes = http.post(loginUrl, loginPayload);

    let loginJson = JSON.parse(loginRes.body);

    // ✅ 动态 token
    let token = loginJson.data.access_token;

    // ✅ 动态 userId（这次是这个字段）
    let userId = loginJson.data.userId;

    console.log(`登录成功: ${user.telephone} userId: ${userId}`);

    // ========================
    // 2️⃣ 学习接口
    // ========================
    let studyUrl = `https://b2bdev.lzdxedu.com/producer/study/h5/addRecord?access_token=${token}`;

    let studyPayload = JSON.stringify({
        tarUserId: userId,   // ✅ 用登录返回的 userId
        tarCompanyId: 9993,
        viewType: 6,
        planId: "22304",
        productId: "65",
        contentId: 555,
        liveId: 0,
        viewTime: 2,
        endTime: 2,
        cacheSize: 0,
        cacheTime: 0,
        videoFormat: 3,
        videoSize: 30,
        videoTime: 214,
        verifyTime: Date.now(), // ✅ 动态时间更真实
        orderId: null
    });

    let params = {
        headers: {
            'Content-Type': 'application/json'
        }
    };

    let studyRes = http.post(studyUrl, studyPayload, params);

    console.log(`用户: ${user.telephone} 学习状态: ${studyRes.status}`);

    sleep(1);
}
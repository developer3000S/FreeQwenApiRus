const BASE_URL = 'http://localhost:3264/api';

async function testServerSidePolling() {
    console.log('\n=== Режим 1: polling на стороне сервера (waitForCompletion=true) ===');
    console.log('Сервер сам ждёт завершения...');

    const start = Date.now();

    try {
        const response = await fetch(`${BASE_URL}/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                message: 'Мирный горный пейзаж с текущими реками',
                model: 'qwen3-vl-plus',
                chatType: 't2v',
                size: '16:9',
                waitForCompletion: true
            })
        });

        const data = await response.json();
        const sec = ((Date.now() - start) / 1000).toFixed(1);

        if (data.error) {
            console.log(`ОШИБКА (${sec}s): ${data.error}`);
            return { ok: false, sec };
        }

        const url = data.video_url || data.choices?.[0]?.message?.content;
        console.log(`OK (${sec}s): ${url}`);
        return { ok: true, sec };
    } catch (e) {
        const sec = ((Date.now() - start) / 1000).toFixed(1);
        console.log(`ОШИБКА (${sec}s): ${e.message}`);
        return { ok: false, sec };
    }
}

async function testClientSidePolling() {
    console.log('\n=== Режим 2: polling на стороне клиента (waitForCompletion=false) ===');
    console.log('Сервер сразу отдаёт task_id, клиент сам поллит...');

    const start = Date.now();

    try {
        const response = await fetch(`${BASE_URL}/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                message: 'Тихий лес, солнечные лучи проходят сквозь деревья',
                model: 'qwen3-vl-plus',
                chatType: 't2v',
                size: '16:9',
                waitForCompletion: false
            })
        });

        const taskData = await response.json();
        const reqSec = ((Date.now() - start) / 1000).toFixed(1);

        if (!taskData.task_id) {
            console.log(`ОШИБКА (${reqSec}s): task_id не получен`);
            return { ok: false, sec: reqSec };
        }

        console.log(`Таск создан за ${reqSec}s, task_id: ${taskData.task_id}`);

        const taskId = taskData.task_id;
        const maxAttempts = 90;
        const interval = 2000;

        for (let i = 1; i <= maxAttempts; i++) {
            await new Promise(r => setTimeout(r, interval));

            const statusResp = await fetch(`${BASE_URL}/tasks/status/${taskId}`);
            const statusData = await statusResp.json();
            const sec = ((Date.now() - start) / 1000).toFixed(1);

            if (statusData.error) {
                console.log(`  [${i}/${maxAttempts}] (${sec}s) Ошибка: ${statusData.error}`);
                continue;
            }

            const status = statusData.task_status || statusData.status;
            console.log(`  [${i}/${maxAttempts}] (${sec}s) ${status}`);

            if (status === 'completed' || status === 'succeeded') {
                const url = statusData.content || statusData.data?.content;
                console.log(`OK (${sec}s, ${i} попыток): ${url}`);
                return { ok: true, sec, attempts: i };
            }

            if (status === 'failed' || status === 'error') {
                console.log(`ОШИБКА (${sec}s): таск упал`);
                return { ok: false, sec, attempts: i };
            }
        }

        const sec = ((Date.now() - start) / 1000).toFixed(1);
        console.log(`ТАЙМАУТ (${sec}s, ${maxAttempts} попыток)`);
        return { ok: false, sec, timeout: true };
    } catch (e) {
        const sec = ((Date.now() - start) / 1000).toFixed(1);
        console.log(`ОШИБКА (${sec}s): ${e.message}`);
        return { ok: false, sec };
    }
}

async function main() {
    console.log('==============================================');
    console.log(' Тест сравнения polling для генерации видео');
    console.log('==============================================');

    const server = await testServerSidePolling();

    console.log('\n--- Пауза 5 сек перед следующим тестом ---\n');
    await new Promise(r => setTimeout(r, 5000));

    const client = await testClientSidePolling();

    console.log('\n==============================================');
    console.log(' Результаты');
    console.log('==============================================');
    console.log(`Серверный polling: ${server.ok ? 'OK' : 'ОШИБКА'} (${server.sec}s)`);
    console.log(`Клиентский polling: ${client.ok ? 'OK' : 'ОШИБКА'} (${client.sec}s)`);
    console.log('==============================================\n');

    process.exit(server.ok || client.ok ? 0 : 1);
}

main();

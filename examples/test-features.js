const BASE_URL = 'http://localhost:3264/api';

async function testChat() {
    console.log('\n=== Тест: Текстовый чат (t2t) ===');
    try {
        const response = await fetch(`${BASE_URL}/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                message: 'Назови столицу Франции.',
                model: 'qwen-max-latest'
            })
        });

        const data = await response.json();
        if (data.error) {
            console.log('ОШИБКА:', data.error);
            return false;
        }
        console.log('OK:', data.choices[0].message.content.substring(0, 100));
        return true;
    } catch (error) {
        console.log('ОШИБКА:', error.message);
        return false;
    }
}

async function testImageGeneration() {
    console.log('\n=== Тест: Генерация изображения (t2i) ===');
    try {
        const response = await fetch(`${BASE_URL}/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                message: 'Красивый закат над спокойным океаном с оранжевыми и розовыми облаками',
                model: 'qwen3-vl-plus',
                chatType: 't2i',
                size: '16:9'
            })
        });

        const data = await response.json();
        if (data.error) {
            console.log('ОШИБКА:', data.error);
            return false;
        }
        console.log('OK:', data.choices[0].message.content.substring(0, 120));
        return true;
    } catch (error) {
        console.log('ОШИБКА:', error.message);
        return false;
    }
}

async function testVideoGeneration() {
    console.log('\n=== Тест: Генерация видео (t2v) ===');
    console.log('(может занять 1-2 минуты)');
    try {
        const response = await fetch(`${BASE_URL}/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                message: 'Тихий лес, солнечные лучи проходят сквозь деревья',
                model: 'qwen3-vl-plus',
                chatType: 't2v',
                size: '16:9'
            })
        });

        const data = await response.json();
        if (data.error) {
            console.log('ОШИБКА:', data.error);
            return false;
        }
        console.log('OK:', data.video_url || data.choices[0].message.content.substring(0, 120));
        return true;
    } catch (error) {
        console.log('ОШИБКА:', error.message);
        return false;
    }
}

async function main() {
    console.log('==============================');
    console.log(' Тесты возможностей FreeQwenApi');
    console.log('==============================');

    const chat = await testChat();
    const image = await testImageGeneration();
    const video = await testVideoGeneration();

    console.log('\n==============================');
    console.log(' Результаты');
    console.log('==============================');
    console.log('Чат (t2t):', chat ? 'OK' : 'ОШИБКА');
    console.log('Изображение (t2i):', image ? 'OK' : 'ОШИБКА');
    console.log('Видео (t2v):', video ? 'OK' : 'ОШИБКА');
    console.log('==============================\n');

    process.exit(chat && image && video ? 0 : 1);
}

main();

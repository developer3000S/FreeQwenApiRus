import readline from 'readline';

/**
 * Интерактивный ввод из stdin.
 * @param {string} question — текст вопроса
 * @returns {Promise<string>} — ответ пользователя (trimmed)
 */
export function prompt(question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim()); }));
}

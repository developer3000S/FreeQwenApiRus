#!/bin/bash

# FREEQWENAPI Start Script
# Скрипт для очистки портов и запуска всей системы (Frontend + Backend)

clear
echo "-------------------------------------"
echo "   FreeQwenAPI 1.0 - Запуск системы      "
echo "-------------------------------------"

# 1. Очистка портов
PORTS=(3264)

for port in "${PORTS[@]}"; do
    echo "Проверка порта $port..."
    PID=$(lsof -ti :$port)
    if [ -n "$PID" ]; then
        echo "Убиваю процесс с PID: $PID для порта $port"
        kill -9 $PID
    else
        echo "Порт $port свободен"
    fi
done

echo "-------------------------------------"

# 2. Проверка наличия node_modules (опционально)
if [ ! -d "node_modules" ]; then
    echo "Внимание: Зависимости не установлены."
    echo "Запустите 'npm run install' перед стартом."
    exit 1
fi

# 3. Запуск системы
echo "Запуск FreQwenAPI ..."
# npm run auth
npm run models:sync
SKIP_ACCOUNT_MENU=true npm start

echo "В другом терминале:";
echo "npm run smoke";

echo "Если всё хорошо, API доступен здесь:";
echo "http://localhost:3264/api"

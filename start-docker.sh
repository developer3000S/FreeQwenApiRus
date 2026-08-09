#!/bin/bash

# ─────────────────────────────────────────────────────────────
# FreeQwenAPI - Docker Start Script
# Удаляет старые образы и запускает систему через Docker Compose
# ─────────────────────────────────────────────────────────────

set -euo pipefail

# Цвета для вывода
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Имена образов, которые собираются локально (из docker-compose.yml)
LOCAL_IMAGES=(
  "qwen-proxy"
)

# Имена контейнеров
CONTAINERS=(
  "qwen-proxy"
)

# clear
echo -e "${BLUE}══════════════════════════════════════════════${NC}"
echo -e "${BLUE}     FreeQwenAPI - Docker Deploy Script       ${NC}"
echo -e "${BLUE}══════════════════════════════════════════════${NC}"
echo ""

# ─────────────────────────────────────────────────────────────
# 1. Остановка и удаление старых контейнеров
# ─────────────────────────────────────────────────────────────
echo -e "${YELLOW}[1/4] Остановка старых контейнеров...${NC}"

RUNNING=$(docker compose ps -q 2>/dev/null || true)
if [ -n "$RUNNING" ]; then
  docker compose down --remove-orphans
  echo -e "${GREEN}  ✓ Контейнеры остановлены и удалены${NC}"
else
  echo -e "  → Активных контейнеров нет, пропускаем"
fi

# ─────────────────────────────────────────────────────────────
# 2. Удаление старых локальных образов
# ─────────────────────────────────────────────────────────────
echo ""
echo -e "${YELLOW}[2/4] Удаление старых образов...${NC}"

REMOVED=0

for IMAGE in "${LOCAL_IMAGES[@]}"; do
  # Ищем образы по имени (точное совпадение и с тегом)
  IMAGE_IDS=$(docker images --filter "reference=${IMAGE}" -q 2>/dev/null)
  if [ -n "$IMAGE_IDS" ]; then
    echo -e "  → Удаляю образ: ${IMAGE}"
    docker rmi -f $IMAGE_IDS
    REMOVED=$((REMOVED + 1))
  fi
done

# Дополнительно — dangling (осиротевшие) образы
DANGLING=$(docker images -f "dangling=true" -q 2>/dev/null)
if [ -n "$DANGLING" ]; then
  echo -e "  → Удаляю неиспользуемые (dangling) образы..."
  docker rmi -f $DANGLING
  REMOVED=$((REMOVED + 1))
fi

if [ "$REMOVED" -eq 0 ]; then
  echo -e "  → Старых образов не найдено"
else
  echo -e "${GREEN}  ✓ Образы удалены${NC}"
fi

# ─────────────────────────────────────────────────────────────
# 3. Сборка новых образов
# ─────────────────────────────────────────────────────────────
echo ""
echo -e "${YELLOW}[3/4] Сборка образов (без кэша)...${NC}"
echo -e "  → Это может занять несколько минут..."

docker compose build --no-cache

echo -e "${GREEN}  ✓ Образы успешно собраны${NC}"

# ─────────────────────────────────────────────────────────────
# 4. Запуск всей системы
# ─────────────────────────────────────────────────────────────
echo ""
echo -e "${YELLOW}[4/4] Запуск системы...${NC}"

docker compose up -d

echo ""
echo -e "${GREEN}══════════════════════════════════════════════${NC}"
echo -e "${GREEN}      ✓ Система успешно запущена!             ${NC}"
echo -e "${GREEN}══════════════════════════════════════════════${NC}"
echo ""
echo -e "  🌐 Frontend:  ${BLUE}http://localhost:8081${NC}"
echo -e "  🔧 Backend:   ${BLUE}http://localhost:3001${NC}"
echo -e "  🗄️  MinIO:     ${BLUE}http://localhost:9001${NC}"
echo ""
echo -e "${YELLOW}Логи контейнеров:${NC}"
echo -e "  docker compose logs -f"
echo -e "  docker compose logs -f backend"
echo -e "  docker compose logs -f frontend"
echo ""

# ─────────────────────────────────────────────────────────────
# Статус контейнеров
# ─────────────────────────────────────────────────────────────
echo -e "${YELLOW}Статус контейнеров:${NC}"
docker compose ps

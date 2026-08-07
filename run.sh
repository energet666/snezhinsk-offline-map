#!/bin/sh
# Запуск оффлайн-карты Снежинска. Работает без интернета.
# Использование: ./run.sh [порт]   (по умолчанию 8765)
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

PYTHON=""
for candidate in python3 python; do
    if command -v "$candidate" >/dev/null 2>&1; then
        PYTHON="$candidate"
        break
    fi
done

if [ -z "$PYTHON" ]; then
    echo "Не найден python3. Установите Python 3 (например: apt install python3 / dnf install python3)." >&2
    exit 1
fi

exec "$PYTHON" server.py "$@"

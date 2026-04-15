#!/bin/bash
# Dupla kattintás a Finderben: megnyit egy terminált és elindítja a helyi szervert.
cd "$(dirname "$0")" || exit 1
PORT=8765
echo ""
echo "  Mappa: $(pwd)"
echo "  Nyisd meg a böngészőben (másold be a címsorba):"
echo "    http://127.0.0.1:${PORT}/repertoar.html"
echo "    http://127.0.0.1:${PORT}/index.html"
echo ""
echo "  Leállítás: Ctrl+C ebben az ablakban."
echo ""
exec python3 -m http.server "$PORT" --bind 127.0.0.1

#ifdef __EMSCRIPTEN__
#include "utils/browser_player.hpp"
#include <emscripten.h>

EM_JS(int, platform_player_id, (char* destination), {
    var id = Module['platformIdentity'] && Module['platformIdentity'].id;
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) return 0;
    stringToUTF8(id, destination, 37);
    return 1;
});

EM_JS(int, platform_has_item, (const char* item_id), {
    var id = UTF8ToString(item_id);
    if (!/^[A-Za-z0-9_.-]{1,100}$/.test(id)) return 0;
    var items = Module['platformInventory'];
    return Array.isArray(items) && items.some(function(item) { return item.item_id === id; }) ? 1 : 0;
});

std::string BrowserPlayer::id()
{
    char value[37] = {};
    return platform_player_id(value) ? std::string(value) : std::string();
}

bool BrowserPlayer::hasItem(const std::string& item_id)
{
    if (item_id.size() > 100) return false;
    return platform_has_item(item_id.c_str()) != 0;
}
#endif

#ifndef HEADER_BROWSER_PLAYER_HPP
#define HEADER_BROWSER_PLAYER_HPP

#ifdef __EMSCRIPTEN__
#include <string>

// Presentation identity/inventory snapshot from the authenticated platform.
// Never use this client-side bridge to authorize rewards or purchases.
namespace BrowserPlayer
{
    std::string id();
    bool hasItem(const std::string& item_id);
}
#endif
#endif

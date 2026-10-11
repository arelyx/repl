-- Run by every `lua` (LUA_INIT): find rocks installed into the repl's tree
-- (luarocks --tree /home/runner/app/.repl/lua, see packager.py).
local tree = "/home/runner/app/.repl/lua"
local v = _VERSION:match("%d+%.%d+")
package.path = tree .. "/share/lua/" .. v .. "/?.lua;" .. tree .. "/share/lua/" .. v .. "/?/init.lua;" .. package.path
package.cpath = tree .. "/lib/lua/" .. v .. "/?.so;" .. package.cpath

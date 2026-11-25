--!strict
-- header comment for torture.luau
local core = require("app.core")
local Signal = require(script.Parent.Signal)

-- doc for Point
type Point = { x: number, y: number }
--- doc for exported Handler
export type Handler = (msg: string) -> ()
export type Generic<T> = { value: T }
type FromTypeof = typeof(require(script.Parent.Config))

--- doc for typedTop
function typedTop(a: number, b: string?): boolean
	return a > 0 and b ~= nil
end

function genericFn<T>(v: T): T
	return v
end

function multiRet(): (number, string)
	return 1, "x"
end

local function emptyOneLiner() end

local M = {}
local CONST_N = 7

function M.make(n: number): Point
	return { x = n, y = n }
end

function M:update(p: Point, cb: Handler)
	type BodyLocal = { z: number }
	local Config = require(script.Parent.Config)
	local msg = `point {p.x} of {Config.total()}`
	cb(msg)
	self:redraw()
	self.canvas.flush()
	M.make(3)
	local v = if p.x > 0 then bump() else drop()
	v += grow()
	local narrowed = p :: any
	for i = 1, 10 do
		if i % 2 == 0 then
			continue
		end
	end
end

M.registry = { on_make = M.make, plain = typedTop }

typedTop(1, "s")
M.make(2)
M:update({ x = 1, y = 2 }, print)

local préfixe = "café"
function after_unicode() end
return M

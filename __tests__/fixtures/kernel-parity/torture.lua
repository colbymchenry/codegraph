#!/usr/bin/env lua
-- File-header comment run line 1
-- line 2 of the run
local core = require("app.core")
local Signal = require(script.Parent.Signal)
local quoted = require 'app.quoted'
local bracketed = require [[app.bracketed]]
local viaChild = require(script:WaitForChild("Child"))
local accessed = require("app.acc").field
local dyn = require(dynName)
local twoA, twoB = require("two.a"), require("two.b")
local okG, guarded = pcall(require, "app.guarded")

--- LuaDoc summary for topFn.
-- @param a number
-- @return number
function topFn(a)
	return a + 1
end

--[[ Block comment doc
spanning two lines ]]
local function localFn(...)
	return select("#", ...)
end

-- doc for anonAssigned (variable, initializer invisible)
local anonAssigned = function(v)
	return hidden(v)
end

local M = {}
local UPPER_CONST = 42

function M.create(n)
	local inst = { n = n }
	return setmetatable(inst, { __index = M })
end

function M:render(opts)
	local lazy = require("app.lazy")
	self.count = (self.count or 0) + 1
	self:helperMethod(opts)
	self.field.deep(1)
	M.create(2)
	M.registry[key](3)
	core.util.log("msg")
	core.run(M.create)
	local function inner()
		return topFn(9)
	end
	function M.attached(q)
		return q
	end
	function leakedGlobal()
	end
	return inner()
end

function M.sub.deep:chained(x)
	return x
end

function _G.installed()
end

M.assigned = function(z)
	return topFn(z)
end

M.handlers = { on_start = topFn, on_stop = localFn, skipped = missing }
local tbl = { cb = topFn, [1] = localFn, nested = { deep_cb = topFn } }

globalAssign = topFn(10)
M.cb = cb

topFn(11)
M.create(12)
M:render({})
M.sub.deep:chained(13)
core.util.log("direct")
t2[k2](14)
f2()(15)

function paren_conv()
	(handler)(16)
end

local one = 1 local two = 2 print(one, two)

local s1 = [[long
string]]
local s2 = [==[nested ]] ok]==]
local x <const> = 99
local préfixe = "café"
function after_unicode() end
do goto done end
::done::
return M

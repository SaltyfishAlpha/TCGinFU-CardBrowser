'use strict';
// 从 Unity 工程的 C# 源码里读出引擎真正会调用的 Lua 钩子名。
// 这样「钩子拼错了」的检查以引擎为准，而不是以工具里写死的一张表为准；
// 找不到源码（比如只拷了内容包出来）就退回内置的表。

const fs = require('fs');
const path = require('path');

const HOOK_LITERAL = /"((?:on_[a-z_]+)|can_play|transform_condition)"/g;
const TRIGGER_LITERAL = /BattleTrigger\.\w+\s*=>\s*"([a-z_]+)"/g;

function findEngineHooks(engineDir) {
  if (!engineDir) return null;
  const dir = path.join(engineDir, 'Assets', 'Scripts', 'Scripting');
  const behaviourCs = path.join(dir, 'LuaCardBehaviour.cs');
  const proxiesCs = path.join(dir, 'LuaProxies.cs');
  let src;
  try { src = fs.readFileSync(behaviourCs, 'utf8'); } catch { return null; }
  const hooks = new Set();
  let m;
  // 只看代码，跳过 /// 文档注释里的示例
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  while ((m = HOOK_LITERAL.exec(code))) hooks.add(m[1]);
  try {
    const p = fs.readFileSync(proxiesCs, 'utf8');
    while ((m = TRIGGER_LITERAL.exec(p))) hooks.add(`on_${m[1]}`);
  } catch { /* 没有也行 */ }
  return hooks.size ? { hooks: [...hooks].sort(), source: path.relative(engineDir, dir) } : null;
}

module.exports = { findEngineHooks };

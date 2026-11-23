-- 测试用脚本。
--
-- 写法约定同正式内容包。

-- ───────────────── 打击 ─────────────────
-- 「造成6点物理伤害【暴击】。命中后令目标获得【破绽】。」
behaviour("strike", {
  on_resolved = function(ctx)
    local s = "a } string with { braces"
    apply_status(ctx.target, "exposed", 1)
    --[[ 块注释里的 } 也不能打乱配对 ]]
  end,
})

-- ───────────────── 漂移 ─────────────────
-- 「造成5点物理伤害；若目标处于后排，再抽1张牌。」
behaviour("drifted", {
  on_attack = function(atk, me)
    if atk.target then
      local t = { nested = { 1, 2 } }
    end
  end,
  on_attak_typo = function(atk, me) end,
})

-- ───────────────── 形态击 ─────────────────
-- 「造成B_atk+4点物理伤害。」
behaviour("form_hit", {
  on_resolved = function(ctx)
    apply_status(ctx.target, "no_such_status", 1)
  end,
})

behaviour("orphan", {
  on_round_end = function(me) end,
})

// semanticRenamer.js — give deobfuscated variables human-readable names
// Runs after localify. At that point single/double-letter lowercase variables
// (a, b, c, ... aa, ab ...) are top-level unique names from localify.js.
// Capital-letter variables (A, B, C ...) are per-function register names from
// cleaner.js and may shadow across functions — we skip those to stay safe.

const query = require('../mods/query');

// ── Lua built-ins / known globals we must never collide with ─────────────────
const RESERVED = new Set([
    // Lua standard
    'print', 'warn', 'error', 'pcall', 'xpcall', 'type',
    'tostring', 'tonumber', 'select', 'unpack', 'rawget', 'rawset',
    'rawequal', 'rawlen', 'pairs', 'ipairs', 'next', 'assert',
    'require', 'load', 'loadstring', 'dofile', 'loadfile',
    'collectgarbage', 'coroutine', 'debug', 'io', 'os', 'package',
    'getmetatable', 'setmetatable', 'getfenv', 'setfenv',
    'string', 'table', 'math', 'bit', 'utf8',
    // Roblox globals
    'game', 'workspace', 'script', 'plugin', 'shared',
    'Enum', 'Instance', 'Color3', 'Vector2', 'Vector3', 'CFrame',
    'UDim', 'UDim2', 'Ray', 'Region3', 'Rect', 'NumberRange',
    'NumberSequence', 'ColorSequence', 'BrickColor', 'TweenInfo',
    'PhysicalProperties', 'Random', 'DateTime', 'task',
    // Deobf pipeline names
    'Env', 'T', 'R', 'C', 'f', 'c', 's',
    // common arg names produced by cleaner
    'arg1', 'arg2', 'arg3', 'arg4', 'arg5', 'arg6', 'arg7', 'arg8',
    // Lua keywords (just in case a hint clashes)
    'and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for',
    'function', 'goto', 'if', 'in', 'local', 'nil', 'not', 'or',
    'repeat', 'return', 'then', 'true', 'until', 'while',
]);

// Only rename variables that look obviously generated (short alphabetic names
// from localify, or v/r-prefixed register names).
const BORING_NAME = /^[a-zA-Z]{1,3}$|^[rv]\d+$/;

// ── Hint extraction ───────────────────────────────────────────────────────────

/**
 * Try to extract a semantic name hint from an initialiser expression.
 * Returns a non-empty string or null.
 */
function getHint(expr) {
    if (!expr || typeof expr !== 'object') return null;

    switch (expr.type) {
        // local x = someTable.field  →  "field"
        case 'MemberExpression': {
            const id = expr.identifier?.name;
            if (id && id.length > 2 && !RESERVED.has(id)) return id;
            return null;
        }

        // local x = env["someKey"]  →  "someKey"
        case 'IndexExpression': {
            const idx = expr.index;
            if (idx?.type === 'StringLiteral') {
                const key = idx.raw
                    ? idx.raw.slice(1, -1)   // strip surrounding quotes
                    : (idx.value ?? '');
                if (key.length > 2 && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key) && !RESERVED.has(key))
                    return key;
            }
            return null;
        }

        // local x = SomeTable:GetService("Name")  /  obj:FindFirstChild("Name")
        case 'CallExpression': {
            const base = expr.base;
            if (base?.type === 'MemberExpression') {
                const method = base.identifier?.name ?? '';
                const wantsStringArg = [
                    'GetService', 'FindFirstChild', 'WaitForChild',
                    'FindFirstChildOfClass', 'FindFirstAncestorOfClass',
                    'FindFirstChildWhichIsA',
                ].includes(method);
                if (wantsStringArg) {
                    const firstArg = expr.arguments?.[0];
                    if (firstArg?.type === 'StringLiteral') {
                        const svc = firstArg.raw
                            ? firstArg.raw.slice(1, -1)
                            : (firstArg.value ?? '');
                        if (svc && /^[a-zA-Z]/.test(svc)) return svc;
                    }
                }
            }
            return null;
        }

        // local x = function(...)  →  "fn"
        case 'FunctionDeclaration':
            return 'fn';

        // local x = {}  →  "tbl"
        case 'TableConstructorExpression':
            return 'tbl';

        default:
            return null;
    }
}

/** Strip non-identifier characters and ensure valid Lua identifier start. */
function sanitize(hint) {
    return hint.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^(\d)/, '_$1');
}

// ── AST walking helpers ───────────────────────────────────────────────────────

/** Replace every Identifier whose .name === oldName with newName across the whole subtree. */
function renameAll(root, oldName, newName) {
    const stack = Array.isArray(root) ? [...root] : [root];
    const seen  = new WeakSet();
    while (stack.length) {
        const node = stack.pop();
        if (!node || typeof node !== 'object') continue;
        if (seen.has(node)) continue;
        seen.add(node);
        if (node.type === 'Identifier' && node.name === oldName) {
            node.name = newName;
        }
        for (const key in node) {
            const v = node[key];
            if (Array.isArray(v))
                for (const c of v) stack.push(c);
            else if (v && typeof v === 'object')
                stack.push(v);
        }
    }
}

// ── Main export ───────────────────────────────────────────────────────────────

module.exports = (output) => {
    // Track which new names are already taken to avoid collisions.
    const usedNames = new Set(RESERVED);

    /** Choose a unique name starting from `base`, appending numbers as needed. */
    const uniquify = (base) => {
        if (!usedNames.has(base)) return base;
        let suffix = 2;
        while (usedNames.has(base + suffix)) suffix++;
        return base + suffix;
    };

    // Collect rename plan: we must plan all renames first, THEN apply them,
    // so that we don't confuse a newly-chosen name with an existing one.
    const plan = []; // [{ oldName, newName }]

    const statements = query(output, 'LocalStatement').concat(query(output, 'AssignmentStatement'));

    for (const stat of statements) {
        if (!stat || !stat.type) continue;

        let varNode, initNode;
        if (stat.type === 'LocalStatement') {
            if (stat.variables?.length !== 1 || stat.init?.length !== 1) continue;
            varNode = stat.variables[0];
            initNode = stat.init[0];
        } else if (stat.type === 'AssignmentStatement') {
            if (stat.variables?.length !== 1 || stat.init?.length !== 1) continue;
            varNode = stat.variables[0];
            initNode = stat.init[0];
        } else {
            continue;
        }

        if (!varNode || varNode.type !== 'Identifier') continue;

        const oldName = varNode.name;
        if (!oldName || !BORING_NAME.test(oldName)) continue;
        if (RESERVED.has(oldName)) continue;

        const hint = getHint(initNode);
        if (!hint) continue;

        const base      = sanitize(hint);
        const newName   = uniquify(base);

        if (newName === oldName) continue; // no change

        plan.push({ oldName, newName });
        // Pre-claim the new name so later iterations see it as taken.
        usedNames.add(newName);
        // Also remove oldName from usedNames so it can be reused later if
        // needed (unlikely but correct).
        usedNames.delete(oldName);
    }

    // Apply the renames in one pass over the whole AST.
    for (const { oldName, newName } of plan) {
        renameAll(output, oldName, newName);
    }
};

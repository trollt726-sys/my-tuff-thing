// postprocess.js — final clean-up pass after the main deobfuscation pipeline

const { is, Clear, search, fixRaw, fixString, solveMath } = require("../mods/helper");
const query = require("../mods/query");


// ── Helpers ──────────────────────────────────────────────────────────────────

/** Compact cleared (empty-object) nodes out of every array in the AST. */
function compactBodies(root) {
    if (!root || typeof root !== "object") return;
    if (Array.isArray(root)) {
        for (let i = root.length - 1; i >= 0; i--) {
            const n = root[i];
            if (n && typeof n === "object" && !n.type && Object.keys(n).length === 0)
                root.splice(i, 1);
            else
                compactBodies(n);
        }
        return;
    }
    for (const key in root) compactBodies(root[key]);
}

/**
 * Count occurrences of an identifier name in read positions (everywhere except
 * the LHS of assignments / declarations / loop variables).
 */
function countReads(root, name) {
    let count = 0;
    const walk = (node, skipKeys = new Set()) => {
        if (!node || typeof node !== "object") return;
        if (Array.isArray(node)) { node.forEach(n => walk(n)); return; }

        if (node.type === "Identifier" && node.name === name) { count++; return; }

        const mySkip = new Set();
        if (node.type === "AssignmentStatement" || node.type === "LocalStatement") {
            mySkip.add("variables");
            if (node.variables) {
                for (const variable of node.variables) {
                    if (variable.type === "MemberExpression") {
                        walk(variable.base);
                    } else if (variable.type === "IndexExpression") {
                        walk(variable.base);
                        walk(variable.index);
                    }
                }
            }
        }
        if (node.type === "FunctionDeclaration")
            mySkip.add("identifier"), mySkip.add("parameters");
        if (node.type === "ForNumericStatement")
            mySkip.add("variable");
        if (node.type === "ForGenericStatement")
            mySkip.add("variables");

        for (const key in node) {
            if (skipKeys.has(key) || mySkip.has(key)) continue;
            walk(node[key]);
        }
    };
    walk(root);
    return count;
}

/** Walk every body-array in the AST and apply a mutating visitor. */
function walkBodies(root, visit) {
    if (!root || typeof root !== "object") return;
    if (Array.isArray(root)) {
        visit(root);
        root.forEach(n => walkBodies(n, visit));
        return;
    }
    for (const key in root) {
        if (key === "body" || key === "stats" || key === "clauses") {
            const val = root[key];
            if (Array.isArray(val)) {
                visit(val);
                val.forEach(n => walkBodies(n, visit));
            }
        } else {
            walkBodies(root[key], visit);
        }
    }
}

/** Test if two AST identifier nodes refer to the same name. */
const sameId = (a, b) =>
    a && b && a.type === "Identifier" && b.type === "Identifier" && a.name === b.name;

/** Check if a CallExpression is a safe standard function call. */
function isCallSafe(node) {
    if (!node || node.type !== "CallExpression") return false;
    let name = null;
    if (node.base?.type === "Identifier") {
        name = node.base.name;
    } else if (node.base?.type === "MemberExpression") {
        const baseName = node.base.base?.name;
        const idName = node.base.identifier?.name;
        if (baseName && idName) {
            name = baseName + "." + idName;
        }
    }

    const safeFuncs = new Set([
        "math.random", "math_random", "random",
        "math.sin", "math.cos", "math.tan", "math.sqrt", "math.abs", "math.floor", "math.ceil",
        "tostring", "tonumber",
        "string.gmatch", "string_gmatch", "gmatch",
        "string.sub", "string.len", "string.char", "string.dump", "string.find", "string.match", "string.gsub",
        "string.split", "string_split",
        "pcall", "xpcall",
        "type", "select", "unpack", "table.unpack", "table.concat",
        "debug.getinfo", "getinfo",
        "debug.getlocal", "getlocal",
        "debug.getupvalue", "getupvalue",
        "debug.sethook", "sethook"
    ]);

    if (!name || !safeFuncs.has(name)) {
        return false;
    }

    // Ensure all arguments are also safe/pure expressions
    if (node.arguments) {
        for (const arg of node.arguments) {
            if (!isPureExpression(arg)) return false;
        }
    }
    return true;
}

/** Check if an expression is pure/safe (has no CallExpressions except safe/pure ones). */
function isPureExpression(node) {
    if (!node || typeof node !== "object") return true;
    if (Array.isArray(node)) {
        return node.every(isPureExpression);
    }
    if (node.type === "CallExpression") {
        return isCallSafe(node);
    }
    for (const key in node) {
        if (!isPureExpression(node[key])) return false;
    }
    return true;
}

// ── Main export ───────────────────────────────────────────────────────────────

// Constants hoisted outside the per-pass loop for performance
const KEYWORDS = new Set([
    'and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for',
    'function', 'goto', 'if', 'in', 'local', 'nil', 'not', 'or',
    'repeat', 'return', 'then', 'true', 'until', 'while',
]);

const SIMPLE_INLINE_TYPES = new Set(["NumericLiteral", "StringLiteral", "BooleanLiteral", "NilLiteral", "Identifier"]);
const SAFE_INLINE_TYPES   = new Set(["NumericLiteral", "StringLiteral", "BooleanLiteral", "NilLiteral", "Identifier", "MemberExpression"]);
const SAFE_REMOVE_TYPES   = new Set(["NumericLiteral", "StringLiteral", "BooleanLiteral", "NilLiteral", "Identifier", "TableConstructorExpression", "VarargLiteral", "BinaryExpression", "LogicalExpression", "UnaryExpression"]);

module.exports = (output) => {
    let changed = true;
    let passes = 0;

    while (changed && passes < 40) {
        changed = false;
        passes++;

        // ── 1. Remove infinite-loop-only functions (anti-tamper bailout stubs) ───
        // These are functions whose only statement is a `while true do` loop with no `wait()`.
        for (const stat of query(output, "FunctionDeclaration")) {
            if (!stat.type) continue;
            const body = stat.body;
            if (!Array.isArray(body)) continue;
            const real = body.filter(s => s?.type);
            // Match: [while true do ... end]  OR  [while true do ... end, return]
            const firstIsInfLoop = real[0]?.type === "WhileStatement" &&
                real[0].condition?.type === "BooleanLiteral" && real[0].condition.value === true;
            const restAreDeadReturns = real.slice(1).every(s =>
                s.type === "ReturnStatement" && !(s.arguments?.length)
            );
            if (firstIsInfLoop && restAreDeadReturns) {
                // Check if it contains a `wait()` or `task.wait()`. If so, it's a valid game loop!
                const calls = query(real[0].body, "CallExpression");
                const hasWait = calls.some(c => {
                    const name = c.base?.name;
                    if (name === "wait") return true;
                    if (c.base?.type === "MemberExpression" &&
                        c.base.base?.name === "task" && c.base.identifier?.name === "wait") return true;
                    return false;
                });

                if (!hasWait) {
                    Clear(stat); changed = true;
                }
            }
        }

        // Clean up empty IIFE calls (like `return ()` generated when Pass 1 clears an IIFE)
        for (const stat of query(output, "ReturnStatement")) {
            if (stat.arguments?.length === 1 && stat.arguments[0]?.type === "CallExpression") {
                const call = stat.arguments[0];
                if (call.base && Object.keys(call.base).length === 0) {
                    Clear(stat); changed = true;
                }
            }
        }

        // ── 2. Remove pcall integrity-check clusters ─────────────────────────────
        for (let i = 0; i < output.length - 1; i++) {
            const s0 = output[i], s1 = output[i + 1];
            if (!s0 || !s1) continue;
            if (
                s0.type === "LocalStatement" &&
                s0.variables?.length === 1 &&
                s0.init?.[0]?.type === "BooleanLiteral" &&
                s0.init[0].value === false &&
                s1.type === "LocalStatement" &&
                s1.init?.[0]?.type === "CallExpression" &&
                s1.init[0].base?.name === "pcall"
            ) {
                const pcallVarName = s1.variables?.[0]?.name;
                Clear(s0); Clear(s1); changed = true;
                for (let j = i + 2; j < Math.min(i + 10, output.length); j++) {
                    const sj = output[j];
                    if (!sj?.type) continue;
                    if (sj.type === "LocalStatement" && sj.init?.length === 1 && sj.init[0]?.name === pcallVarName) {
                        Clear(sj); changed = true; continue;
                    }
                    if (sj.type === "IfStatement" && sj.clauses?.[0]?.condition?.name === pcallVarName) {
                        Clear(sj); changed = true; continue;
                    }
                    if (sj.type !== "LocalStatement" && sj.type !== "IfStatement") break;
                }
            }
        }

        // ── 3. Remove anti-tamper for-loops ─────────────────────────────────────
        for (const stat of query(output, "ForNumericStatement")) {
            if (!stat.type) continue;
            const startIsOne = stat.start?.type === "NumericLiteral" && stat.start.value === 1;
            const endIsVar = stat.end?.type === "Identifier";
            if (!startIsOne || !endIsVar) continue;
            const innerPcalls = query(stat.body ?? [], { type: "CallExpression", base: { name: "pcall" } });
            const innerErrors = query(stat.body ?? [], { type: "CallExpression", base: { name: "error" } });
            if (innerPcalls.length >= 1 && innerErrors.length >= 1) {
                Clear(stat); changed = true;
            }
        }

        // ── 4. Remove `if cond then error(...); return end` tamper guards ────────
        for (const stat of query(output, "IfStatement")) {
            if (!stat.type) continue;
            if (stat.clauses?.length !== 1) continue;
            const body = stat.clauses[0].body ?? [];
            const real = body.filter(s => s?.type);
            const hasError = real.some(s =>
                s.type === "CallStatement" &&
                s.expression?.type === "CallExpression" &&
                s.expression?.base?.name === "error"
            );
            const hasReturn = real.some(s => s.type === "ReturnStatement");
            if (hasError && hasReturn && real.length <= 3) {
                Clear(stat); changed = true;
            }
        }

        // ── 5. (Removed: unsafe NilLiteral local wipe) ────────────────────────────

        // ── 6. Simplify constant-condition if-blocks (ALL bodies, not just root) ─
        walkBodies(output, (body) => {
            for (let i = 0; i < body.length; i++) {
                const stat = body[i];
                if (!stat?.type || stat.type !== "IfStatement") continue;
                const clause = stat.clauses?.[0];
                if (!clause) continue;
                const cond = clause.condition;
                if (!cond) continue;

                if (cond.type === "BooleanLiteral") {
                    if (cond.value === true && stat.clauses.length === 1) {
                        body.splice(i, 1, ...(clause.body ?? []));
                        i--; changed = true;
                    } else if (cond.value === false) {
                        // Use else clause body if present, otherwise remove
                        const elseClause = stat.clauses.find(c => c.type === "ElseClause");
                        if (elseClause) {
                            body.splice(i, 1, ...(elseClause.body ?? []));
                            i--; changed = true;
                        } else {
                            body.splice(i, 1); i--; changed = true;
                        }
                    }
                }
            }
        });

        // ── 7. Remove self-assignments: x = x  or  a, b = a, b ──────────────────
        for (const stat of query(output, "AssignmentStatement")) {
            if (!stat.type) continue;
            if (stat.variables?.length !== stat.init?.length) continue;
            const allSelf = stat.variables.every((v, i) => sameId(v, stat.init[i]));
            if (allSelf) { Clear(stat); changed = true; }
        }

        // ── 8. Remove empty do-end blocks ────────────────────────────────────────
        walkBodies(output, (body) => {
            for (let i = body.length - 1; i >= 0; i--) {
                const s = body[i];
                if (s?.type === "DoStatement") {
                    const real = (s.body ?? []).filter(x => x?.type);
                    if (real.length === 0) {
                        body.splice(i, 1); changed = true;
                    }
                }
            }
        });

        // ── 9. Remove dead code after return in function / top-level bodies ───────
        walkBodies(output, (body) => {
            for (let i = 0; i < body.length - 1; i++) {
                const s = body[i];
                if (s?.type === "ReturnStatement") {
                    const dead = body.splice(i + 1);
                    if (dead.length > 0) changed = true;
                    break;
                }
            }
        });

        // ── 10. `not true` → `false`, `not false` → `true`, `not not x` → `x` ──
        for (const expr of query(output, { type: "UnaryExpression", operator: "not" })) {
            if (!expr.type) continue;
            const arg = expr.argument;
            if (arg?.type === "BooleanLiteral") {
                Object.assign(expr, { type: "BooleanLiteral", value: !arg.value, raw: !arg.value ? "true" : "false" });
                delete expr.operator; delete expr.argument;
                changed = true;
            } else if (arg?.type === "UnaryExpression" && arg.operator === "not") {
                // not (not x) → x
                Object.assign(expr, arg.argument);
                changed = true;
            }
        }

        // ── 11. Collapse `local x = expr; return x` at end of bodies ─────────────
        walkBodies(output, (body) => {
            if (body.length < 2) return;
            const last = body[body.length - 1];
            const prev = body[body.length - 2];
            if (
                last?.type === "ReturnStatement" &&
                last.arguments?.length === 1 &&
                last.arguments[0]?.type === "Identifier" &&
                prev?.type === "LocalStatement" &&
                prev.variables?.length === 1 &&
                sameId(prev.variables[0], last.arguments[0]) &&
                prev.init?.length === 1
            ) {
                // Replace with: return <expr>
                last.arguments[0] = prev.init[0];
                body.splice(body.length - 2, 1);
                changed = true;
            }
        });

        // ── 12. Dead local removal (multi-pass — converges each outer loop) ───────
        for (const stat of query(output, "LocalStatement")) {
            if (!stat.type) continue;
            if (stat.variables?.length !== 1) continue;
            const varName = stat.variables[0]?.name;
            if (!varName) continue;
            // Count every occurrence of the name across the full output
            const total = countReads(output, varName);
            // total includes the declaration variable node itself (1)
            // plus occurrences in the init expression
            // If ≤1 it was only in the LHS declaration and nowhere else
            if (total <= 1) { Clear(stat); changed = true; }
        }

        // ── 13. Remove `repeat <body> until true` → inline body ──────────────────
        walkBodies(output, (body) => {
            for (let i = body.length - 1; i >= 0; i--) {
                const s = body[i];
                if (
                    s?.type === "RepeatStatement" &&
                    s.condition?.type === "BooleanLiteral" &&
                    s.condition.value === true
                ) {
                    body.splice(i, 1, ...(s.body ?? []));
                    changed = true;
                }
            }
        });

        // ── 14. Inline single-use locals: local x = <simple>; use(x) → use(<simple>) ─
        const simpleTypes = new Set(["NumericLiteral", "StringLiteral", "BooleanLiteral", "NilLiteral", "Identifier"]);
        walkBodies(output, (body) => {
            for (let i = 0; i < body.length - 1; i++) {
                const decl = body[i];
                if (
                    decl?.type !== "LocalStatement" ||
                    decl.variables?.length !== 1 ||
                    decl.init?.length !== 1 ||
                    !simpleTypes.has(decl.init[0]?.type)
                ) continue;

                const varName = decl.variables[0]?.name;
                if (!varName) continue;

                let readCount = 0;
                for (let j = i + 1; j < body.length; j++)
                    readCount += countReads(body[j], varName);

                if (readCount !== 1) continue;

                const replaceIn = (node) => {
                    if (!node || typeof node !== "object") return;
                    if (Array.isArray(node)) { node.forEach(replaceIn); return; }
                    for (const key in node) {
                        if (node[key]?.type === "Identifier" && node[key].name === varName) {
                            node[key] = decl.init[0];
                            return;
                        }
                        replaceIn(node[key]);
                    }
                };
                replaceIn(body[i + 1]);
                body.splice(i, 1);
                changed = true;
                i--;
            }
        });

        // ── 15. Remove else clauses whose body is empty ───────────────────────────
        for (const stat of query(output, "IfStatement")) {
            if (!stat.type || !stat.clauses) continue;
            stat.clauses = stat.clauses.filter(c => {
                if (c.type === "ElseClause" && !(c.body?.filter(s => s?.type).length)) {
                    changed = true;
                    return false;
                }
                return true;
            });
            if (stat.clauses.length === 0) { Clear(stat); changed = true; }
        }

        // ── 16. Dead Function Removal ─────────────────────────────────────────────
        for (const stat of query(output, "LocalStatement")) {
            if (!stat.type || stat.variables?.length !== 1 || stat.init?.length !== 1) continue;
            if (stat.init[0]?.type !== "FunctionDeclaration" && stat.init[0]?.type !== "FunctionLiteral") continue;
            const varName = stat.variables[0]?.name;
            if (!varName) continue;
            const total = countReads(output, varName);
            if (total <= 1) { Clear(stat); changed = true; }
        }
        for (const stat of query(output, "FunctionDeclaration")) {
            if (!stat.type || !stat.isLocal) continue;
            const varName = stat.identifier?.name;
            if (!varName) continue;
            const total = countReads(output, varName);
            if (total <= 1) { Clear(stat); changed = true; }
        }

        // ── 17. Unwrap safe DoStatements ─────────────────────────────────────────
        walkBodies(output, (body) => {
            for (let i = body.length - 1; i >= 0; i--) {
                const s = body[i];
                if (s?.type === "DoStatement") {
                    const innerStats = s.body ?? [];
                    const hasLocals = innerStats.some(x => x?.type === "LocalStatement");
                    if (!hasLocals) {
                        body.splice(i, 1, ...innerStats);
                        changed = true;
                    }
                }
            }
        });

        // ── 18. Negation folding: not (a == b) -> a ~= b ────────────────────────
        for (const expr of query(output, { type: "UnaryExpression", operator: "not" })) {
            if (expr.argument?.type === "BinaryExpression") {
                const op = expr.argument.operator;
                const opposites = { "==": "~=", "~=": "==", "<": ">=", ">": "<=", "<=": ">", ">=": "<" };
                if (opposites[op]) {
                    Object.assign(expr, expr.argument);
                    expr.operator = opposites[op];
                    changed = true;
                }
            }
        }

        // ── 19. If statement with empty if clause and else clause -> invert cond ─
        for (const stat of query(output, "IfStatement")) {
            if (!stat.type || stat.clauses?.length !== 2) continue;
            const [ifClause, elseClause] = stat.clauses;
            if (ifClause.type === "IfClause" && elseClause.type === "ElseClause") {
                const ifReal = (ifClause.body ?? []).filter(s => s?.type);
                if (ifReal.length === 0) {
                    const cond = ifClause.condition;
                    let newCond;
                    if (cond?.type === "BinaryExpression" && ["==", "~=", "<", ">", "<=", ">="].includes(cond.operator)) {
                        const opposites = { "==": "~=", "~=": "==", "<": ">=", ">": "<=", "<=": ">", ">=": "<" };
                        newCond = { ...cond, operator: opposites[cond.operator] };
                    } else if (cond?.type === "UnaryExpression" && cond.operator === "not") {
                        newCond = cond.argument;
                    } else {
                        newCond = { type: "UnaryExpression", operator: "not", argument: cond };
                    }
                    ifClause.condition = newCond;
                    ifClause.body = elseClause.body;
                    stat.clauses = [ifClause];
                    changed = true;
                }
            }
        }

        // ── 20. Return boolean simplification ────────────────────────────────────
        walkBodies(output, (body) => {
            for (let i = 0; i < body.length; i++) {
                const s = body[i];
                if (s?.type === "IfStatement" && s.clauses?.length === 2) {
                    const [ifC, elseC] = s.clauses;
                    if (ifC.type === "IfClause" && elseC.type === "ElseClause") {
                        const ifBody = (ifC.body ?? []).filter(x => x?.type);
                        const elseBody = (elseC.body ?? []).filter(x => x?.type);
                        if (
                            ifBody.length === 1 && ifBody[0].type === "ReturnStatement" &&
                            elseBody.length === 1 && elseBody[0].type === "ReturnStatement"
                        ) {
                            const ifRet = ifBody[0].arguments?.[0];
                            const elseRet = elseBody[0].arguments?.[0];
                            if (ifRet?.type === "BooleanLiteral" && elseRet?.type === "BooleanLiteral") {
                                if (ifRet.value === true && elseRet.value === false) {
                                    body[i] = { type: "ReturnStatement", arguments: [ifC.condition] };
                                    changed = true;
                                } else if (ifRet.value === false && elseRet.value === true) {
                                    body[i] = {
                                        type: "ReturnStatement",
                                        arguments: [{ type: "UnaryExpression", operator: "not", argument: ifC.condition }]
                                    };
                                    changed = true;
                                }
                            }
                        }
                    }
                }
            }
        });

        // ── 21. Remove empty if statements ───────────────────────────────────────
        for (const stat of query(output, "IfStatement")) {
            if (!stat.type || !stat.clauses) continue;
            if (stat.clauses.length === 1 && stat.clauses[0].type === "IfClause") {
                const real = (stat.clauses[0].body ?? []).filter(s => s?.type);
                if (real.length === 0) {
                    // Only remove if condition has no side effects (Identifier, Literal, basic Binary)
                    const cond = stat.clauses[0].condition;
                    const hasCall = query(cond, "CallExpression").length > 0;
                    if (!hasCall) {
                        Clear(stat);
                        changed = true;
                    }
                }
            }
        }

        // ── 22. Fold string concatenations ───────────────────────────────────────
        for (const expr of query(output, { type: "BinaryExpression", operator: ".." })) {
            if (expr.left?.type === "StringLiteral" && expr.right?.type === "StringLiteral") {
                const leftStr = fixRaw(expr.left);
                const rightStr = fixRaw(expr.right);
                if (typeof leftStr === "string" && typeof rightStr === "string") {
                    const combined = leftStr + rightStr;
                    Object.assign(expr, {
                        type: "StringLiteral",
                        value: combined,
                        raw: `"${fixString(combined, '"')}"`
                    });
                    delete expr.left;
                    delete expr.right;
                    delete expr.operator;
                    changed = true;
                }
            }
        }

        // ── 23. Fold math operations ──────────────────────────────────────────────
        for (const expr of query(output, "BinaryExpression")) {
            if (expr.operator && expr.operator !== "..") {
                const solved = solveMath(expr.left, expr.operator, expr.right);
                if (typeof solved === "number" && !isNaN(solved) && isFinite(solved)) {
                    Object.assign(expr, {
                        type: "NumericLiteral",
                        value: solved,
                        raw: String(solved)
                    });
                    delete expr.left;
                    delete expr.right;
                    delete expr.operator;
                    changed = true;
                } else if (typeof solved === "boolean") {
                    Object.assign(expr, {
                        type: "BooleanLiteral",
                        value: solved,
                        raw: solved ? "true" : "false"
                    });
                    delete expr.left;
                    delete expr.right;
                    delete expr.operator;
                    changed = true;
                }
            }
        }

        // ── 24. Collapse uninitialized locals with their assignment ──────────────
        walkBodies(output, (body) => {
            for (let i = 0; i < body.length - 1; i++) {
                const stat1 = body[i];
                const stat2 = body[i + 1];
                if (stat1?.type === "LocalStatement" && stat2?.type === "AssignmentStatement") {
                    // Check if stat1 has no init or all nil
                    if (!stat1.init || stat1.init.length === 0 || stat1.init.every(x => x?.type === "NilLiteral")) {
                        if (stat1.variables?.length > 0 && stat1.variables.length === stat2.variables?.length) {
                            const exactMatch = stat1.variables.every((v, idx) => {
                                const v2 = stat2.variables[idx];
                                return v.type === "Identifier" && v2.type === "Identifier" && v.name === v2.name;
                            });
                            if (exactMatch) {
                                stat1.init = stat2.init;
                                body.splice(i + 1, 1);
                                changed = true;
                            }
                        }
                    }
                }
            }
        });

        // (Pass 25 removed - fundamentally incorrect and caused loss of valid payload code)

        // ── 26. Unwrap `while true do <body> break end` → inline body ─────────────
        walkBodies(output, (body) => {
            for (let i = body.length - 1; i >= 0; i--) {
                const s = body[i];
                if (s?.type !== "WhileStatement") continue;
                const cond = s.condition;
                if (cond?.type !== "BooleanLiteral" || cond.value !== true) continue;
                const inner = (s.body ?? []).filter(x => x?.type);
                const lastInner = inner[inner.length - 1];
                if (lastInner?.type === "BreakStatement") {
                    // `while true do ... break end` — inline all but the break
                    body.splice(i, 1, ...inner.slice(0, -1));
                    changed = true;
                }
            }
        });

        // ── 27. Remove all-nil locals that are immediately overwritten ────────────
        walkBodies(output, (body) => {
            for (let i = 0; i < body.length - 1; i++) {
                const stat1 = body[i];
                if (stat1?.type !== "LocalStatement") continue;
                if (!stat1.init || stat1.init.length === 0 || stat1.init.every(x => x?.type === "NilLiteral")) {
                    const stat2 = body[i + 1];
                    if (stat2?.type !== "AssignmentStatement") continue;
                    const declaredNames = new Set((stat1.variables ?? []).map(v => v.name).filter(Boolean));
                    const assignedNames = new Set((stat2.variables ?? []).filter(v => v.type === "Identifier").map(v => v.name));
                    const allOverwritten = [...declaredNames].every(n => assignedNames.has(n));
                    if (!allOverwritten) continue;
                    const initReads = new Set();
                    for (const init of stat2.init ?? []) {
                        const ids = query(init, "Identifier");
                        for (const id of ids) initReads.add(id.name);
                    }
                    const readBeforeWrite = [...declaredNames].some(n => initReads.has(n));
                    if (readBeforeWrite) continue;
                    stat2.type = "LocalStatement";
                    body.splice(i, 1);
                    changed = true;
                    i--;
                }
            }
        });

        // ── 28. Convert dot-notation method calls to colon-notation ──────────────
        // x.method(x, arg1, ...) → x:method(arg1, ...) when args[0] === base.base
        for (const expr of query(output, "CallExpression")) {
            if (!expr.type) continue;
            const base = expr.base;
            if (base?.type !== "MemberExpression" || base.indexer !== ".") continue;
            const args = expr.arguments ?? [];
            if (args.length === 0) continue;
            const firstArg = args[0];
            const baseBase = base.base;
            // Only handle simple Identifier self-arguments for safety
            if (
                firstArg?.type === "Identifier" && baseBase?.type === "Identifier" &&
                firstArg.name === baseBase.name
            ) {
                base.indexer = ":";
                expr.arguments = args.slice(1);
                changed = true;
            }
        }

        // ── 29. Merge adjacent if-blocks with identical conditions ────────────────
        // `if cond then A end; if cond then B end` → `if cond then A; B end`
        walkBodies(output, (body) => {
            for (let i = 0; i < body.length - 1; i++) {
                const s1 = body[i], s2 = body[i + 1];
                if (s1?.type !== "IfStatement" || s2?.type !== "IfStatement") continue;
                if (s1.clauses?.length !== 1 || s2.clauses?.length !== 1) continue;
                if (s1.clauses[0].type !== "IfClause" || s2.clauses[0].type !== "IfClause") continue;
                // Conditions must match structurally
                if (!is(s1.clauses[0].condition, s2.clauses[0].condition)) continue;
                // First block must NOT end with a return/break
                const body1 = (s1.clauses[0].body ?? []).filter(x => x?.type);
                const last1 = body1[body1.length - 1];
                if (last1?.type === "ReturnStatement" || last1?.type === "BreakStatement") continue;
                // Merge s2's body into s1
                s1.clauses[0].body = (s1.clauses[0].body ?? []).concat(s2.clauses[0].body ?? []);
                body.splice(i + 1, 1);
                changed = true;
            }
        });

        // ── 30. Remove duplicate sequential identical assignments ─────────────────
        // `a = x; a = x` → `a = x`
        walkBodies(output, (body) => {
            for (let i = 0; i < body.length - 1; i++) {
                const s1 = body[i], s2 = body[i + 1];
                if (s1?.type !== "AssignmentStatement" && s1?.type !== "LocalStatement") continue;
                if (s2?.type !== s1.type) continue;
                if (!s1.variables || !s2.variables) continue;
                if (s1.variables.length !== s2.variables.length) continue;
                if (!is(s1.variables, s2.variables) || !is(s1.init, s2.init)) continue;
                // Completely identical assignment — remove the duplicate
                body.splice(i + 1, 1);
                changed = true;
            }
        });

        // ── 31. Remove `_ = expr` throwaway assignments ───────────────────────────
        // Prometheus emits `_ = someValue` as a discard during CF reconstruction.
        // These are safe to remove when `_` is never subsequently read.
        walkBodies(output, (body) => {
            for (let i = 0; i < body.length; i++) {
                const s = body[i];
                if (s?.type !== "AssignmentStatement") continue;
                if (s.variables?.length !== 1) continue;
                if (s.variables[0]?.name !== "_") continue;
                // Check nothing after this reads `_`
                let read = false;
                for (let j = i + 1; j < body.length; j++) {
                    if (countReads(body[j], "_") > 0) { read = true; break; }
                }
                if (!read) { Clear(s); changed = true; }
            }
        });

        // ── 32. Inline non-local single-use intermediate assignments ─────────────
        // `a = <simple>; use(a)` → `use(<simple>)` for side-effect-free RHS
        const safeInlineTypes = new Set([
            "NumericLiteral", "StringLiteral", "BooleanLiteral",
            "NilLiteral", "Identifier", "MemberExpression"
        ]);
        walkBodies(output, (body) => {
            for (let i = 0; i < body.length - 1; i++) {
                const s1 = body[i];
                if (s1?.type !== "AssignmentStatement") continue;
                if (s1.variables?.length !== 1 || s1.init?.length !== 1) continue;
                if (s1.variables[0]?.type !== "Identifier") continue;
                if (!safeInlineTypes.has(s1.init[0]?.type)) continue;
                const varName = s1.variables[0].name;
                // Count reads in the remaining body
                let totalReads = 0;
                for (let j = i + 1; j < body.length; j++)
                    totalReads += countReads(body[j], varName);
                if (totalReads !== 1) continue;
                // Inline into the very next statement
                const replaceIn = (node) => {
                    if (!node || typeof node !== "object") return;
                    if (Array.isArray(node)) { node.forEach(replaceIn); return; }
                    for (const key in node) {
                        if (node[key]?.type === "Identifier" && node[key].name === varName) {
                            node[key] = s1.init[0];
                            return;
                        }
                        replaceIn(node[key]);
                    }
                };
                replaceIn(body[i + 1]);
                body.splice(i, 1);
                changed = true;
                i--;
            }
        });

        // ── 33. Idempotent logical simplification: `a and a` → `a`, `a or a` → `a` ─
        for (const expr of query(output, "LogicalExpression")) {
            if (!expr.type) continue;
            if ((expr.operator === "and" || expr.operator === "or") &&
                expr.left?.type === "Identifier" && expr.right?.type === "Identifier" &&
                expr.left.name === expr.right.name) {
                Object.assign(expr, expr.left);
                delete expr.operator;
                delete expr.right;
                changed = true;
            }
        }

        // ── 34. Dead write elimination: `a = pure; a = anything` removes first ────
        // Only safe when the first RHS has no side effects (no calls)
        walkBodies(output, (body) => {
            for (let i = 0; i < body.length - 1; i++) {
                const s1 = body[i];
                if (s1?.type !== "AssignmentStatement") continue;
                if (s1.variables?.length !== 1 || s1.init?.length !== 1) continue;
                if (s1.variables[0]?.type !== "Identifier") continue;
                // RHS must be side-effect free
                if (query(s1.init[0], "CallExpression").length > 0) continue;
                const varName = s1.variables[0].name;
                // Find the next write to varName before any read
                for (let j = i + 1; j < body.length; j++) {
                    const s2 = body[j];
                    // If s2 reads varName — stop, the first write is needed
                    if (countReads(s2, varName) > 0) break;
                    // If s2 writes varName again — the first write is dead
                    if (
                        (s2?.type === "AssignmentStatement" || s2?.type === "LocalStatement") &&
                        s2.variables?.some(v => v?.name === varName)
                    ) {
                        Clear(s1);
                        changed = true;
                        break;
                    }
                }
            }
        });

        // ── 35. Remove string-arithmetic pcall anti-tamper checks ────────────────
        // Prometheus emits: local x = {pcall(function() return <str>/<str>^<num> end)}
        // The pcall always fails (can't do arithmetic on strings), the result is discarded.
        for (const stat of query(output, "LocalStatement")) {
            if (!stat.type || stat.variables?.length !== 1) continue;
            const init = stat.init?.[0];
            if (init?.type !== "TableConstructorExpression") continue;
            if (init.fields?.length !== 1 || init.fields[0]?.type !== "TableValue") continue;
            const pcallExpr = init.fields[0].value;
            if (pcallExpr?.type !== "CallExpression" || pcallExpr.base?.name !== "pcall") continue;
            const fn = pcallExpr.arguments?.[0];
            if (fn?.type !== "FunctionDeclaration" && fn?.type !== "FunctionLiteral") continue;
            const fnBody = (fn.body ?? []).filter(s => s?.type);
            if (fnBody.length !== 1 || fnBody[0].type !== "ReturnStatement") continue;
            const retExpr = fnBody[0].arguments?.[0];
            // Match: StringLiteral op (NumericLiteral op StringLiteral) patterns
            const isStrArith = (node) => {
                if (!node) return false;
                if (node.type === "StringLiteral" || node.type === "NumericLiteral") return true;
                if (node.type === "BinaryExpression") return isStrArith(node.left) && isStrArith(node.right);
                return false;
            };
            const hasStr = (node) => {
                if (!node) return false;
                if (node.type === "StringLiteral") return true;
                if (node.type === "BinaryExpression") return hasStr(node.left) || hasStr(node.right);
                return false;
            };
            if (isStrArith(retExpr) && hasStr(retExpr)) {
                Clear(stat);
                changed = true;
            }
        }

        // ── 36. Remove unused local functions ────────────────────────────────────
        // Prometheus often generates dead anti-tamper functions.
        // If a function is declared locally and never called or referenced, remove it.
        walkBodies(output, (body) => {
            for (let i = 0; i < body.length; i++) {
                const stat = body[i];
                if (stat?.type !== "LocalStatement" || stat.init?.[0]?.type !== "FunctionDeclaration") continue;
                const funcName = stat.variables?.[0]?.name;
                if (!funcName) continue;
                // Count references to this function name in the ENTIRE script (excluding its own declaration)
                let totalReads = countReads(output, funcName);
                // countReads will count the declaration itself, so we expect exactly 1 if it's unused elsewhere
                if (totalReads === 1) {
                    Clear(stat);
                    changed = true;
                }
            }
        });

        // ── 37. Remove redundant trailing returns ────────────────────────────────
        // `local function f() ... return end` → `local function f() ... end`
        for (const fn of query(output, "FunctionDeclaration")) {
            const body = fn.body;
            if (!Array.isArray(body)) continue;
            const real = body.filter(s => s?.type);
            if (real.length === 0) continue;
            const last = real[real.length - 1];
            if (last.type === "ReturnStatement" && (!last.arguments || last.arguments.length === 0)) {
                // Find the actual node in the body array and remove it
                for (let i = body.length - 1; i >= 0; i--) {
                    if (body[i] === last) {
                        body.splice(i, 1);
                        changed = true;
                        break;
                    }
                }
            }
        }
        // ── 38. Remove unused local variables ────────────────────────────────────
        // Removes `local a = <simple>` if `a` is never read in the whole script.
        const safeToRemoveTypes = new Set([
            "NumericLiteral", "StringLiteral", "BooleanLiteral", "NilLiteral",
            "Identifier", "TableConstructorExpression", "VarargLiteral",
            "BinaryExpression", "LogicalExpression", "UnaryExpression"
        ]);

        walkBodies(output, (body) => {
            for (let i = 0; i < body.length; i++) {
                const stat = body[i];
                if (stat?.type !== "LocalStatement") continue;
                if (!stat.variables || stat.variables.length !== 1) continue;

                const varName = stat.variables[0].name;
                if (!varName || varName === "_") continue;

                // Check if init is pure/safe to remove
                const init = stat.init?.[0];
                let isPure = false;
                if (!init) {
                    isPure = true;
                } else {
                    // It's pure if it contains no calls OR only safe calls
                    if (isPureExpression(init)) {
                        isPure = true;
                    }
                }

                if (isPure) {
                    // Count reads globally. 1 means only the declaration exists.
                    if (countReads(output, varName) === 1) {
                        Clear(stat);
                        changed = true;
                    }
                }
            }
        });
        // ── 39. Unwrap opaque `#var == 0` payload wrappers ───────────────────────
        // Prometheus often leaves behind dead array-shuffling loops, followed by 
        // `if #var == 0 then <payload>`. If the if-block contains the bulk of the script, unwrap it.
        walkBodies(output, (body) => {
            for (let i = 0; i < body.length; i++) {
                const stat = body[i];
                if (stat?.type !== "IfStatement") continue;
                if (stat.clauses?.length !== 1) continue;
                const cond = stat.clauses[0].condition;
                if (cond?.type !== "BinaryExpression" || cond.operator !== "==") continue;
                if (cond.left?.type !== "UnaryExpression" || cond.left.operator !== "#") continue;
                if (cond.right?.type !== "NumericLiteral" || cond.right.value !== 0) continue;

                const innerBody = (stat.clauses[0].body ?? []).filter(x => x?.type);
                // If it's wrapping a significant chunk of code, it's the payload wrapper
                if (innerBody.length > 5) {
                    body.splice(i, 1, ...innerBody);
                    changed = true;
                    i--;
                }
            }
        });

        // ── 39b. Unwrap top-level opaque `if var then <payload>` wrappers ────────
        // If a top-level if-statement conditional on a single identifier wraps the bulk
        // of the script, it is the payload wrapper left over by anti-tamper. Unwrap it.
        for (let i = 0; i < output.length; i++) {
            const stat = output[i];
            if (stat?.type !== "IfStatement") continue;
            if (stat.clauses?.length !== 1) continue;
            const cond = stat.clauses[0].condition;
            if (cond?.type !== "Identifier") continue;

            const innerBody = (stat.clauses[0].body ?? []).filter(x => x?.type);
            if (innerBody.length > 5) {
                const totalStats = output.filter(x => x?.type).length;
                if (innerBody.length >= totalStats * 0.5) {
                    output.splice(i, 1, ...innerBody);
                    changed = true;
                    i--;
                }
            }
        }

        // ── 40. Boolean constant folding ─────────────────────────────────────────
        // `a and true` → `a`, `a or false` → `a`
        for (const expr of query(output, "LogicalExpression")) {
            if (!expr.type) continue;
            const isTrue = (n) => n?.type === "BooleanLiteral" && n.value === true;
            const isFalse = (n) => n?.type === "BooleanLiteral" && n.value === false;

            if (expr.operator === "and") {
                if (isTrue(expr.right)) { Object.assign(expr, expr.left); changed = true; }
                else if (isTrue(expr.left)) { Object.assign(expr, expr.right); changed = true; }
            } else if (expr.operator === "or") {
                if (isFalse(expr.right)) { Object.assign(expr, expr.left); changed = true; }
                else if (isFalse(expr.left)) { Object.assign(expr, expr.right); changed = true; }
            }
        }
        // ── 41. Remove self-assignments ──────────────────────────────────────────
        // `a = a` → removed (often generated after boolean folding `a = a and true`)
        walkBodies(output, (body) => {
            for (let i = 0; i < body.length; i++) {
                const stat = body[i];
                if (stat?.type !== "AssignmentStatement") continue;
                if (stat.variables?.length !== 1 || stat.init?.length !== 1) continue;
                if (stat.variables[0]?.type === "Identifier" && stat.init[0]?.type === "Identifier" &&
                    stat.variables[0].name === stat.init[0].name) {
                    Clear(stat);
                    changed = true;
                }
            }
        });
        // ── 42. Remove dead `elseif` branches ────────────────────────────────────
        // `if a then ... elseif a then <dead> end` → `if a then ... end`
        for (const stat of query(output, "IfStatement")) {
            if (!stat.clauses || stat.clauses.length <= 1) continue;
            const seenConditions = [];
            for (let i = 0; i < stat.clauses.length; i++) {
                const clause = stat.clauses[i];
                if (clause.type === "ElseClause") continue;

                // For simplicity, only check Identifiers or simple Literals
                const cond = clause.condition;
                if (cond?.type === "Identifier" || cond?.type === "BooleanLiteral" || cond?.type === "NumericLiteral" || cond?.type === "StringLiteral") {
                    const condStr = cond.type === "Identifier" ? cond.name : String(cond.value);
                    if (seenConditions.includes(condStr)) {
                        // Dead branch! Remove it.
                        stat.clauses.splice(i, 1);
                        changed = true;
                        i--;
                    } else {
                        seenConditions.push(condStr);
                    }
                }
            }
        }

        // ── 43. Remove empty `else` and `elseif` blocks ──────────────────────────
        // `if a then b() else end` → `if a then b() end`
        for (const stat of query(output, "IfStatement")) {
            if (!stat.clauses) continue;
            for (let i = stat.clauses.length - 1; i >= 1; i--) {
                const clause = stat.clauses[i];
                const realBody = (clause.body ?? []).filter(x => x?.type);

                if (realBody.length === 0) {
                    if (clause.type === "ElseClause") {
                        stat.clauses.splice(i, 1);
                        changed = true;
                    } else if (clause.type === "ElseifClause") {
                        const hasCall = query(clause.condition, "CallExpression").length > 0;
                        if (!hasCall) {
                            stat.clauses.splice(i, 1);
                            changed = true;
                        }
                    }
                }
            }
        }

        // ── 44. Local single-use variable inlining ───────────────────────────────
        // Inlines `b = game; b:GetService(); b = workspace` → `game:GetService()`
        walkBodies(output, (body) => {
            for (let i = 0; i < body.length - 1; i++) {
                const s1 = body[i], s2 = body[i + 1];
                if (s1?.type !== "AssignmentStatement" && s1?.type !== "LocalStatement") continue;
                if (!s1.variables || s1.variables.length !== 1 || !s1.init || s1.init.length !== 1) continue;
                const varNode = s1.variables[0];
                if (varNode.type !== "Identifier") continue;
                const varName = varNode.name;

                // init must be pure (no side effects)
                if (query(s1.init[0], "CallExpression").length > 0) continue;

                // Count actual reads in s2 (excluding LHS)
                let reads = 0;
                const countActualReads = (node) => {
                    if (!node || typeof node !== "object") return;
                    for (const key in node) {
                        if ((node.type === "AssignmentStatement" || node.type === "LocalStatement") && key === "variables") continue;
                        if (node[key]?.type === "Identifier" && node[key].name === varName) {
                            reads++;
                        } else {
                            countActualReads(node[key]);
                        }
                    }
                };
                countActualReads(s2);

                // s2 must read varName EXACTLY once
                if (reads !== 1) continue;

                // Check if varName is overwritten before it is ever read again
                let safeToInline = false;
                for (let j = i + 2; j < body.length; j++) {
                    if (countReads(body[j], varName) > 0) {
                        break; // Unsafe, read again
                    }
                    if ((body[j]?.type === "AssignmentStatement" || body[j]?.type === "LocalStatement") &&
                        (body[j].variables ?? []).some(v => v?.name === varName)) {
                        safeToInline = true;
                        break;
                    }
                }

                // If it's the very last use in the block, it's also safe
                if (!safeToInline && i + 2 === body.length) {
                    safeToInline = true;
                }

                if (safeToInline) {
                    const replaceLocal = (node) => {
                        if (!node || typeof node !== "object") return;
                        for (const key in node) {
                            if ((node.type === "AssignmentStatement" || node.type === "LocalStatement") && key === "variables") continue;
                            if (node[key]?.type === "Identifier" && node[key].name === varName) {
                                node[key] = JSON.parse(JSON.stringify(s1.init[0]));
                            } else {
                                replaceLocal(node[key]);
                            }
                        }
                    };
                    replaceLocal(s2);
                    Clear(s1);
                    changed = true;
                }
            }
        });

        // ── 45. Dead loop and debug anti-tamper cleanup ──────────────────────────
        // Removes sethook calls, funcs loops, and other debug/antitamper loops that 
        // only affect dead variables.
        const getDeadVars = () => {
            const dead = new Set();
            for (const stat of query(output, "LocalStatement")) {
                if (!stat.type || !stat.variables) continue;
                for (const v of stat.variables) {
                    if (v?.type === "Identifier" && countReads(output, v.name) <= 1) {
                        dead.add(v.name);
                    }
                }
            }
            return dead;
        };

        const deadVars = getDeadVars();

        const isStatSafe = (stat) => {
            if (!stat || !stat.type) return true;
            if (stat.type === "AssignmentStatement" || stat.type === "LocalStatement") {
                const allDead = stat.variables?.every(v => v?.type === "Identifier" && deadVars.has(v.name));
                if (!allDead) return false;
                return stat.init?.every(isPureExpression) ?? true;
            }
            if (stat.type === "IfStatement") {
                for (const clause of stat.clauses ?? []) {
                    if (clause.condition && !isPureExpression(clause.condition)) return false;
                    const bodySafe = clause.body?.every(isStatSafe);
                    if (!bodySafe) return false;
                }
                return true;
            }
            if (stat.type === "CallStatement") {
                return isPureExpression(stat.expression);
            }
            if (stat.type === "DoStatement") {
                return stat.body?.every(isStatSafe) ?? true;
            }
            return false;
        };

        walkBodies(output, (body) => {
            for (let i = 0; i < body.length; i++) {
                const s = body[i];
                if (!s || !s.type) continue;

                if (s.type === "ForNumericStatement") {
                    if (isPureExpression(s.start) && isPureExpression(s.end) && (!s.step || isPureExpression(s.step))) {
                        if (s.body?.every(isStatSafe)) {
                            Clear(s); changed = true;
                        }
                    }
                } else if (s.type === "ForGenericStatement") {
                    if (s.iterators?.every(isPureExpression)) {
                        if (s.body?.every(isStatSafe)) {
                            Clear(s); changed = true;
                        }
                    }
                } else if (s.type === "CallStatement") {
                    // Only remove call statements that are both pure AND whose result is discarded
                    // (i.e. not a named function call that could have real side effects)
                    const callExpr = s.expression;
                    if (isPureExpression(callExpr) && isCallSafe(callExpr)) {
                        Clear(s); changed = true;
                    }
                }
            }
        });

        // ── 46. Boolean absorption laws ──────────────────────────────────────────
        // `a or true` → `true`, `true or a` → `true`
        // `a and false` → `false`, `false and a` → `false`
        for (const expr of query(output, "LogicalExpression")) {
            if (!expr.type) continue;
            const isTrue  = (n) => n?.type === "BooleanLiteral" && n.value === true;
            const isFalse = (n) => n?.type === "BooleanLiteral" && n.value === false;
            if (expr.operator === "or") {
                if (isTrue(expr.left) || isTrue(expr.right)) {
                    Object.assign(expr, { type: "BooleanLiteral", value: true, raw: "true" });
                    delete expr.operator; delete expr.left; delete expr.right;
                    changed = true;
                }
            } else if (expr.operator === "and") {
                if (isFalse(expr.left) || isFalse(expr.right)) {
                    Object.assign(expr, { type: "BooleanLiteral", value: false, raw: "false" });
                    delete expr.operator; delete expr.left; delete expr.right;
                    changed = true;
                }
            }
        }

        // ── 47. Unary minus constant folding: -(N) → -N ─────────────────────────
        for (const expr of query(output, { type: "UnaryExpression", operator: "-" })) {
            if (!expr.type) continue;
            const arg = expr.argument;
            if (arg?.type === "NumericLiteral") {
                Object.assign(expr, { type: "NumericLiteral", value: -arg.value, raw: String(-arg.value) });
                delete expr.operator; delete expr.argument;
                changed = true;
            }
        }

        // ── 48. `if x == true then` → `if x then` / `if x == false then` → `if not x then` ─
        for (const stat of query(output, "IfStatement")) {
            if (!stat.clauses) continue;
            for (const clause of stat.clauses) {
                if (!clause.condition) continue;
                const cond = clause.condition;
                if (cond.type !== "BinaryExpression") continue;
                if (cond.operator === "==") {
                    if (cond.right?.type === "BooleanLiteral" && cond.right.value === true) {
                        clause.condition = cond.left;
                        changed = true;
                    } else if (cond.right?.type === "BooleanLiteral" && cond.right.value === false) {
                        clause.condition = { type: "UnaryExpression", operator: "not", argument: cond.left };
                        changed = true;
                    } else if (cond.left?.type === "BooleanLiteral" && cond.left.value === true) {
                        clause.condition = cond.right;
                        changed = true;
                    } else if (cond.left?.type === "BooleanLiteral" && cond.left.value === false) {
                        clause.condition = { type: "UnaryExpression", operator: "not", argument: cond.right };
                        changed = true;
                    }
                } else if (cond.operator === "~=") {
                    if (cond.right?.type === "BooleanLiteral" && cond.right.value === false) {
                        // x ~= false → x (truthy check)
                        clause.condition = cond.left;
                        changed = true;
                    } else if (cond.right?.type === "BooleanLiteral" && cond.right.value === true) {
                        clause.condition = { type: "UnaryExpression", operator: "not", argument: cond.left };
                        changed = true;
                    }
                }
            }
        }

        // ── 49. Remove trailing `local _ = nil` / `local _ = false` stubs ────────
        // Prometheus leaves dead guard variables at end of anti-tamper sections.
        walkBodies(output, (body) => {
            for (let i = body.length - 1; i >= 0; i--) {
                const s = body[i];
                if (s?.type !== "LocalStatement") continue;
                if (s.variables?.length !== 1) continue;
                const varName = s.variables[0]?.name;
                if (!varName || varName === "_") continue;
                const init = s.init?.[0];
                const isDeadInit = !init || init.type === "NilLiteral" ||
                    (init.type === "BooleanLiteral" && init.value === false);
                if (!isDeadInit) break; // stop at first real statement
                if (countReads(output, varName) <= 1) {
                    Clear(s); changed = true;
                } else {
                    break;
                }
            }
        });

        // ── 50. Placeholder (reserved)

        // ── 51. Convert bracket-string indexing to dot notation ─────────────────
        // `x["validKey"]` → `x.validKey` wherever the key is a valid Lua identifier
        // and NOT a Lua keyword. Greatly improves readability of Prometheus output.
        for (const expr of query(output, "IndexExpression")) {
            if (!expr.type) continue;
            const idx = expr.index;
            if (idx?.type !== "StringLiteral") continue;
            // Extract the raw key string
            const raw = idx.raw ?? '';
            const key = raw.length >= 2 ? raw.slice(1, -1) : (idx.value ?? '');
            // Must be a valid Lua identifier and not a keyword
            if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) continue;
            if (KEYWORDS.has(key)) continue;
            // Convert to MemberExpression with dot indexer
            Object.assign(expr, {
                type: "MemberExpression",
                indexer: ".",
                identifier: { type: "Identifier", name: key },
            });
            delete expr.index;
            changed = true;
        }

        // Compact after each pass
        compactBodies(output);
    }
};

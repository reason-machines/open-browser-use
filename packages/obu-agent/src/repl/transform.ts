// r2-repl: turn one REPL cell into the body of an async function whose
// top-level bindings persist on the sandbox global.
//
//   const x = 1; let {a} = o; function f() {}; class C {}; await g(); x + 1
// becomes
//   f = function f() {};            // function declarations hoisted
//   (x = 1); ({a} = o); C = class C {}; await g(); return (x + 1);
//
// The sandbox runs sloppy-mode code, so assigning an undeclared name creates a
// global on the context: the next cell sees it. Re-declaring a name in a later
// cell is therefore not an error (agents are still told to use fresh names).
import { parse, type Node } from "acorn";

interface Positioned {
  start: number;
  end: number;
}
type AnyNode = Node & Positioned & Record<string, any>;

export class ReplSyntaxError extends SyntaxError {}

export function transformCell(code: string): string {
  let program: AnyNode;
  try {
    program = parse(code, {
      ecmaVersion: "latest",
      sourceType: "script",
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
      allowHashBang: true,
    }) as AnyNode;
  } catch (error) {
    const message = (error as Error).message;
    if (/'import' and 'export'/.test(message) || /Cannot use import/.test(message)) {
      throw new ReplSyntaxError("import/export are not available in the browser REPL; everything you need is already a global");
    }
    throw new ReplSyntaxError(message);
  }
  const body = program.body as AnyNode[];
  const hoisted: string[] = [];
  const out: string[] = [];
  let cursor = 0;
  body.forEach((stmt, index) => {
    // Keep comments / whitespace between statements.
    out.push(code.slice(cursor, stmt.start));
    cursor = stmt.end;
    const src = code.slice(stmt.start, stmt.end);
    const isLast = index === body.length - 1;
    switch (stmt.type) {
      case "ImportDeclaration":
      case "ExportNamedDeclaration":
      case "ExportDefaultDeclaration":
      case "ExportAllDeclaration":
        throw new ReplSyntaxError("import/export are not available in the browser REPL; everything you need is already a global");
      case "VariableDeclaration": {
        const parts: string[] = [];
        for (const decl of stmt.declarations as AnyNode[]) {
          const target = code.slice(decl.id.start, decl.id.end);
          if (decl.init) {
            parts.push(`(${target} = ${code.slice(decl.init.start, decl.init.end)});`);
          } else if (stmt.kind !== "var" && decl.id.type === "Identifier") {
            parts.push(`(${target} = undefined);`);
          }
        }
        out.push(parts.join(" "));
        return;
      }
      case "FunctionDeclaration":
        hoisted.push(`${stmt.id.name} = ${src};`);
        return;
      case "ClassDeclaration":
        out.push(`${stmt.id.name} = ${src};`);
        return;
      case "ExpressionStatement":
        if (isLast) {
          out.push(`return (${code.slice(stmt.expression.start, stmt.expression.end)});`);
          return;
        }
        out.push(src);
        return;
      default:
        out.push(src);
    }
  });
  out.push(code.slice(cursor));
  return `${hoisted.join("\n")}\n${out.join("")}`;
}

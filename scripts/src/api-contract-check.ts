import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import type {
  CliSignature,
  CommandSignature,
  OptionSignature,
} from "./command-api.js";

interface DeclaredOption {
  name: string;
  required: boolean;
  repeatable: boolean;
  flag: boolean;
}

interface DeclaredCommand {
  executable: string;
  command: string;
  options: DeclaredOption[];
}

function fail(message: string): never {
  throw new Error(`API contract check failed: ${message}`);
}

function jsDocText(node: ts.Node): string {
  return ts
    .getJSDocCommentsAndTags(node)
    .filter(ts.isJSDoc)
    .map((doc) => (typeof doc.comment === "string" ? doc.comment.trim() : ""))
    .filter(Boolean)
    .join("\n");
}

function tagValue(node: ts.Node, name: string): string | undefined {
  const tag = ts
    .getJSDocTags(node)
    .find((candidate) => candidate.tagName.text === name);
  return typeof tag?.comment === "string" ? tag.comment.trim() : undefined;
}

function propertyName(property: ts.PropertySignature): string {
  const { name } = property;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) {
    return name.text;
  }
  fail(`unsupported property name ${name.getText()}`);
}

function unwrapReadonly(type: ts.TypeNode): ts.TypeNode {
  if (
    ts.isTypeOperatorNode(type) &&
    type.operator === ts.SyntaxKind.ReadonlyKeyword
  ) {
    return type.type;
  }
  return type;
}

function isRepeatable(type: ts.TypeNode): boolean {
  const unwrapped = unwrapReadonly(type);
  return (
    ts.isArrayTypeNode(unwrapped) ||
    (ts.isTypeReferenceNode(unwrapped) &&
      ts.isIdentifier(unwrapped.typeName) &&
      ["Array", "ReadonlyArray"].includes(unwrapped.typeName.text))
  );
}

function isFlag(type: ts.TypeNode): boolean {
  const unwrapped = unwrapReadonly(type);
  return (
    ts.isLiteralTypeNode(unwrapped) &&
    unwrapped.literal.kind === ts.SyntaxKind.TrueKeyword
  );
}

function declaredOptions(
  declaration: ts.InterfaceDeclaration,
): DeclaredOption[] {
  return declaration.members.map((member) => {
    if (!ts.isPropertySignature(member) || !member.type) {
      fail(
        `${declaration.name.text} may contain only typed property signatures`,
      );
    }
    const name = propertyName(member);
    if (!jsDocText(member)) {
      fail(`${declaration.name.text}.${name} has no source JSDoc comment`);
    }
    return {
      name,
      required: !member.questionToken,
      repeatable: isRepeatable(member.type),
      flag: isFlag(member.type),
    };
  });
}

function commandKey(executable: string, command: string): string {
  return `${executable}\0${command}`;
}

function parseDeclaredCommands(sourceText: string): Map<string, DeclaredCommand> {
  const source = ts.createSourceFile(
    "api.ts",
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const interfaces = new Map<string, ts.InterfaceDeclaration>();
  for (const statement of source.statements) {
    if (ts.isInterfaceDeclaration(statement)) {
      interfaces.set(statement.name.text, statement);
    }
  }

  const commands = new Map<string, DeclaredCommand>();
  for (const statement of source.statements) {
    if (!ts.isFunctionDeclaration(statement)) {
      continue;
    }
    const executable = tagValue(statement, "cli");
    const command = tagValue(statement, "command");
    if (!executable && !command) {
      continue;
    }
    if (!executable || !command) {
      fail(`${statement.name?.text ?? "anonymous function"} needs @cli and @command`);
    }
    if (!jsDocText(statement)) {
      fail(`${executable} ${command} has no source JSDoc comment`);
    }

    const parameter = statement.parameters[0];
    let options: DeclaredOption[] = [];
    if (parameter) {
      if (
        !parameter.type ||
        !ts.isTypeReferenceNode(parameter.type) ||
        !ts.isIdentifier(parameter.type.typeName)
      ) {
        fail(`${executable} ${command} must use a named options interface`);
      }
      const optionsInterface = interfaces.get(parameter.type.typeName.text);
      if (!optionsInterface) {
        fail(
          `${executable} ${command} references missing ${parameter.type.typeName.text}`,
        );
      }
      options = declaredOptions(optionsInterface);
    }

    const key = commandKey(executable, command);
    if (commands.has(key)) {
      fail(`duplicate declaration for ${executable} ${command}`);
    }
    commands.set(key, { executable, command, options });
  }
  return commands;
}

function runtimeOption(option: OptionSignature): DeclaredOption {
  return {
    name: option.name,
    required: option.required ?? false,
    repeatable: option.repeatable ?? false,
    flag: option.value === undefined,
  };
}

function compareOptions(
  command: string,
  declared: DeclaredOption[],
  runtime: OptionSignature[],
): void {
  const byName = (options: DeclaredOption[]) =>
    new Map(options.map((option) => [option.name, option]));
  const declaredByName = byName(declared);
  const runtimeByName = byName(runtime.map(runtimeOption));

  for (const [name, option] of declaredByName) {
    const actual = runtimeByName.get(name);
    if (!actual) {
      fail(`${command} declares --${name}, but the runtime manifest does not`);
    }
    for (const property of ["required", "repeatable", "flag"] as const) {
      if (option[property] !== actual[property]) {
        fail(
          `${command} --${name} ${property} is ${option[property]} in API.d.ts and ${actual[property]} in the runtime manifest`,
        );
      }
    }
  }
  for (const name of runtimeByName.keys()) {
    if (!declaredByName.has(name)) {
      fail(`${command} runtime option --${name} is missing from API.d.ts`);
    }
  }
}

function compareCommand(
  api: CliSignature,
  runtime: CommandSignature,
  declared: DeclaredCommand,
): void {
  compareOptions(
    `${api.executable} ${runtime.command}`,
    declared.options,
    runtime.options ?? [],
  );
}

function validateGlobalOptions(
  sourceText: string,
  apis: readonly CliSignature[],
): void {
  const source = ts.createSourceFile(
    "api.ts",
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const globalInterface = source.statements.find(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) &&
      statement.name.text === "GlobalCliOptions",
  );
  if (!globalInterface) {
    fail("GlobalCliOptions is missing");
  }
  const declared = declaredOptions(globalInterface);
  for (const api of apis) {
    compareOptions(
      `${api.executable} global options`,
      declared,
      api.globalOptions ?? [],
    );
  }
}

export function compileApiDefinition(
  sourcePath: string,
  apis: readonly CliSignature[],
): string {
  const sources = readApiSources(sourcePath);
  const sourceText = [...sources.values()].join("\n")
    .replace(/^import type .*;\s*$/gm, "")
    .replace(/^export \* from .*;\s*$/gm, "");
  const result = ts.transpileDeclaration(sourceText, {
    fileName: sourcePath,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.ESNext,
      declaration: true,
      emitDeclarationOnly: true,
      removeComments: false,
    },
  });
  if (result.diagnostics?.length) {
    fail(
      ts.formatDiagnosticsWithColorAndContext(result.diagnostics, {
        getCanonicalFileName: (fileName) => fileName,
        getCurrentDirectory: process.cwd,
        getNewLine: () => "\n",
      }),
    );
  }

  const declared = parseDeclaredCommands(sourceText);
  validateGlobalOptions(sourceText, apis);
  for (const api of apis) {
    for (const runtimeCommand of api.commands) {
      const key = commandKey(api.executable, runtimeCommand.command);
      const declaredCommand = declared.get(key);
      if (!declaredCommand) {
        fail(
          `${api.executable} ${runtimeCommand.command} is missing from the TypeScript API source`,
        );
      }
      compareCommand(api, runtimeCommand, declaredCommand);
      declared.delete(key);
    }
  }
  if (declared.size) {
    const extra = [...declared.values()]
      .map(({ executable, command }) => `${executable} ${command}`)
      .join(", ");
    fail(`TypeScript API source contains commands absent from runtime: ${extra}`);
  }
  if (!result.outputText.includes("/**")) {
    fail("declaration emit removed source JSDoc comments");
  }
  return result.outputText;
}

/** Follows the explicit local index so newly added modules cannot escape checks. */
export function readApiSources(sourcePath: string, sources = new Map<string, string>()): Map<string, string> {
  sourcePath = path.resolve(sourcePath);
  if (sources.has(sourcePath)) return sources;
  const text = fs.readFileSync(sourcePath, "utf8");
  sources.set(sourcePath, text);
  const source = ts.createSourceFile(sourcePath, text, ts.ScriptTarget.Latest, true);
  for (const statement of source.statements) {
    if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const specifier = statement.moduleSpecifier.text;
    if (!specifier.startsWith("./")) fail(`API index must use local modules: ${specifier}`);
    readApiSources(path.resolve(path.dirname(sourcePath), specifier.replace(/\.js$/, ".ts")), sources);
  }
  return sources;
}

/** Emits the small index and independently loadable declarations after the full contract check. */
export function compileApiModules(sourcePath: string, apis: readonly CliSignature[]): Map<string, string> {
  const complete = compileApiDefinition(sourcePath, apis);
  const outputs = new Map<string, string>([["API.full.d.ts", complete]]);
  for (const [file, text] of readApiSources(sourcePath)) {
    const name = file === path.resolve(sourcePath) ? "API.d.ts" : path.relative(path.dirname(sourcePath), file).replace(/\.ts$/, ".d.ts");
    outputs.set(name, ts.transpileDeclaration(text, {
      fileName: file,
      compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext, removeComments: false },
    }).outputText);
  }
  return outputs;
}

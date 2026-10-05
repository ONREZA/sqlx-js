import ts from "typescript";

type Binding<Value> = {
  value?: Value;
  read?: () => Value | undefined;
  resolving?: boolean;
  resolved?: boolean;
};

function readBinding<Value>(binding: Binding<Value>): Value | undefined {
  if (!binding.read || binding.resolved) return binding.value;
  if (binding.resolving) return undefined;
  binding.resolving = true;
  try {
    binding.value = binding.read();
    binding.resolved = true;
    return binding.value;
  } finally {
    binding.resolving = false;
  }
}

export class LexicalScope<Value> {
  readonly bindings = new Map<string, Binding<Value>>();
  parameterBindings?: Map<string, Binding<Value>>;

  constructor(readonly parent?: LexicalScope<Value>) {}

  get(name: string): Value | undefined {
    const binding = this.bindings.get(name);
    return binding ? readBinding(binding) : this.parent?.get(name);
  }
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) => ts.isOmittedExpression(element) ? [] : bindingNames(element.name));
}

function functionWithBody(node: ts.Node): node is ts.FunctionLikeDeclaration & { body: ts.ConciseBody } {
  return (ts.isFunctionDeclaration(node)
    || ts.isFunctionExpression(node)
    || ts.isArrowFunction(node)
    || ts.isMethodDeclaration(node)
    || ts.isConstructorDeclaration(node)
    || ts.isGetAccessorDeclaration(node)
    || ts.isSetAccessorDeclaration(node)) && node.body !== undefined;
}

export function createLexicalScopes<Value>(
  source: ts.SourceFile,
  imports: ReadonlyMap<string, Value>,
  resolveVariable: (declaration: ts.VariableDeclaration, constant: boolean, scope: LexicalScope<Value>) => Value | undefined,
) {
  const root = new LexicalScope<Value>();
  const scopes = new WeakMap<ts.Node, LexicalScope<Value>>();
  const variables = new WeakMap<ts.VariableDeclaration, Binding<Value>>();
  const parameters = new WeakMap<ts.ParameterDeclaration, Binding<Value>>();

  const declare = (scope: LexicalScope<Value>, name: ts.BindingName, binding: Binding<Value> = {}) => {
    for (const identifier of bindingNames(name)) scope.bindings.set(identifier, binding);
  };
  const visit = (node: ts.Node, outer: LexicalScope<Value>, variableOwner: LexicalScope<Value>) => {
    let scope = outer;
    if (functionWithBody(node)) {
      if (ts.isFunctionDeclaration(node) && node.name) declare(outer, node.name);
      scope = new LexicalScope(outer);
      if (ts.isFunctionExpression(node) && node.name) declare(scope, node.name);
      for (const parameter of node.parameters) {
        const binding: Binding<Value> = {};
        declare(scope, parameter.name, binding);
        parameters.set(parameter, binding);
      }
      scopes.set(node, scope);
      ts.forEachChild(node, (child) => {
        if (child !== node.body && !node.parameters.some((parameter) => parameter === child)) {
          visit(child, outer, variableOwner);
        }
      });
      for (const parameter of node.parameters) visit(parameter, scope, variableOwner);
      const bodyScope = new LexicalScope(scope);
      bodyScope.parameterBindings = new Map(node.parameters.flatMap((parameter) =>
        bindingNames(parameter.name).map((name) => [name, parameters.get(parameter)!] as const)
      ));
      visit(node.body, bodyScope, bodyScope);
      return;
    }
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      if (ts.isClassDeclaration(node) && node.name) declare(outer, node.name);
      scope = new LexicalScope(outer);
      if (node.name) declare(scope, node.name);
    } else if (ts.isClassStaticBlockDeclaration(node) || ts.isModuleBlock(node)) {
      scope = new LexicalScope(outer);
      variableOwner = scope;
    } else if (ts.isBlock(node) || ts.isCaseBlock(node)) {
      scope = new LexicalScope(outer);
    } else if (ts.isCatchClause(node)) {
      scope = new LexicalScope(outer);
      if (node.variableDeclaration) declare(scope, node.variableDeclaration.name);
    } else if (
      (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node))
      && node.initializer && ts.isVariableDeclarationList(node.initializer)
      && (node.initializer.flags & ts.NodeFlags.BlockScoped) !== 0
    ) {
      scope = new LexicalScope(outer);
    }
    scopes.set(node, scope);
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      if (clause && !clause.isTypeOnly) {
        if (clause.name) declare(scope, clause.name, { value: imports.get(clause.name.text) });
        const bindings = clause.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) {
          declare(scope, bindings.name, { value: imports.get(bindings.name.text) });
        } else if (bindings) {
          for (const element of bindings.elements) {
            if (!element.isTypeOnly) declare(scope, element.name, { value: imports.get(element.name.text) });
          }
        }
      }
    } else if (ts.isEnumDeclaration(node) || ts.isModuleDeclaration(node)) {
      if (ts.isIdentifier(node.name)) declare(scope, node.name);
    } else if (ts.isVariableDeclarationList(node)) {
      const blockScoped = (node.flags & ts.NodeFlags.BlockScoped) !== 0;
      const constant = (node.flags & ts.NodeFlags.Const) !== 0;
      const owner = blockScoped ? scope : variableOwner;
      for (const declaration of node.declarations) {
        const binding: Binding<Value> = {
          read: () => resolveVariable(declaration, constant, scope),
        };
        variables.set(declaration, binding);
        for (const name of bindingNames(declaration.name)) {
          const existing = owner.bindings.get(name) ?? (!blockScoped ? owner.parameterBindings?.get(name) : undefined);
          owner.bindings.set(name, !blockScoped && !declaration.initializer && existing ? existing : binding);
        }
      }
    }
    ts.forEachChild(node, (child) => visit(child, scope, variableOwner));
  };
  visit(source, root, root);

  return {
    at(node: ts.Node): LexicalScope<Value> {
      return scopes.get(node)!;
    },
    resolveDeclaration(node: ts.VariableDeclaration): Value | undefined {
      const binding = variables.get(node);
      return binding ? readBinding(binding) : undefined;
    },
    setParameter(node: ts.ParameterDeclaration, value: Value) {
      const binding = parameters.get(node);
      if (binding && ts.isIdentifier(node.name)) binding.value = value;
    },
  };
}

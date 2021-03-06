const t = require('@babel/types');
const genExpression = require('../codegen/genExpression');
const isClassComponent = require('../utils/isClassComponent');
const isFunctionComponent = require('../utils/isFunctionComponent');
const traverse = require('../utils/traverseNodePath');

const RAX_PACKAGE = 'rax';
const SUPER_COMPONENT = 'Component';

const CREATE_APP = 'createApp';
const CREATE_COMPONENT = 'createComponent';
const CREATE_PAGE = 'createPage';
const CREATE_STYLE = 'createStyle';

const SAFE_SUPER_COMPONENT = '__component__';
const SAFE_CREATE_APP = '__create_app__';
const SAFE_CREATE_COMPONENT = '__create_component__';
const SAFE_CREATE_PAGE = '__create_page__';
const SAFE_CREATE_STYLE = '__create_style__';

const USE_EFFECT = 'useEffect';
const USE_STATE = 'useState';

const EXPORTED_DEF = '__def__';
const RUNTIME = 'jsx2mp-runtime';

function getConstructor(type) {
  switch (type) {
    case 'app': return 'App';
    case 'page': return 'Page';
    case 'component':
    default: return 'Component';
  }
}
/**
 * Module code transform.
 * 1. Add import declaration of helper lib.
 * 2. Rename scope's Component to other id.
 * 3. Add Component call expression.
 * 4. Transform 'rax' to 'rax/dist/rax.min.js' in case of 小程序开发者工具 not support `process`.
 */
module.exports = {
  parse(parsed, code, options) {
    const { defaultExportedPath, eventHandlers = [] } = parsed;
    let userDefineType;

    if (options.type === 'app') {
      userDefineType = 'class';
      const { id, superClass, body, decorators } = defaultExportedPath.node;
      defaultExportedPath.parentPath.replaceWith(
        t.variableDeclaration('var', [
          t.variableDeclarator(
            t.identifier(EXPORTED_DEF),
            t.classExpression(id, superClass, body, decorators)
          )
        ])
      );
    } else if (isFunctionComponent(defaultExportedPath)) { // replace with class def.
      userDefineType = 'function';
      const { id, generator, async, params, body } = defaultExportedPath.node;
      const replacer = getReplacer(defaultExportedPath);
      if (replacer) {
        replacer.replaceWith(
          t.variableDeclaration('const', [
            t.variableDeclarator(
              t.identifier(EXPORTED_DEF),
              t.functionExpression(id, params, body, generator, async)
            )
          ])
        );
      }
    } else if (isClassComponent(defaultExportedPath)) {
      userDefineType = 'class';

      const { id, superClass, body, decorators } = defaultExportedPath.node;
      const replacer = getReplacer(defaultExportedPath);
      // @NOTE: Remove superClass due to useless of Component base class.
      if (replacer) {
        replacer.replaceWith(
          t.variableDeclaration('const', [
            t.variableDeclarator(
              t.identifier(EXPORTED_DEF),
              t.classExpression(id, t.identifier(SAFE_SUPER_COMPONENT), body, decorators)
            )
          ])
        );
      }
    }

    const hooks = transformHooks(parsed.renderFunctionPath);

    addDefine(parsed.ast, options.type, userDefineType, eventHandlers, parsed.useCreateStyle, hooks);
    removeRaxImports(parsed.ast);
    removeDefaultImports(parsed.ast);
  },
};

function addDefine(ast, type, userDefineType, eventHandlers, useCreateStyle, hooks) {
  let safeCreateInstanceId;
  let importedIdentifier;
  switch (type) {
    case 'app':
      safeCreateInstanceId = SAFE_CREATE_APP;
      importedIdentifier = CREATE_APP;
      break;
    case 'page':
      safeCreateInstanceId = SAFE_CREATE_PAGE;
      importedIdentifier = CREATE_PAGE;
      break;
    case 'component':
      safeCreateInstanceId = SAFE_CREATE_COMPONENT;
      importedIdentifier = CREATE_COMPONENT;
      break;
  }

  traverse(ast, {
    Program(path) {
      const localIdentifier = t.identifier(safeCreateInstanceId);

      // import { createComponent as __create_component__ } from "/__helpers/component";
      const specifiers = [t.importSpecifier(localIdentifier, t.identifier(importedIdentifier))];
      if ((type === 'page' || type === 'component') && userDefineType === 'class') {
        specifiers.push(t.importSpecifier(
          t.identifier(SAFE_SUPER_COMPONENT),
          t.identifier(SUPER_COMPONENT)
        ));
      }

      if (Array.isArray(hooks)) {
        hooks.forEach(id => {
          specifiers.push(t.importSpecifier(t.identifier(id), t.identifier(id)));
        });
      }

      if (useCreateStyle) {
        specifiers.push(t.importSpecifier(
          t.identifier(SAFE_CREATE_STYLE),
          t.identifier(CREATE_STYLE)
        ));
      }

      path.node.body.unshift(
        t.importDeclaration(
          specifiers,
          t.stringLiteral(RUNTIME)
        )
      );

      // Component(__create_component__(__class_def__));
      path.node.body.push(
        t.expressionStatement(
          t.callExpression(
            t.identifier(getConstructor(type)),
            [
              t.callExpression(
                t.identifier(safeCreateInstanceId),
                [
                  t.identifier(EXPORTED_DEF),
                  t.objectExpression([
                    t.objectProperty(t.identifier('events'), t.arrayExpression(eventHandlers.map(e => t.stringLiteral(e))))
                  ])
                ]
              )
            ],
          )
        )
      );
    },
  });
}

function removeRaxImports(ast) {
  traverse(ast, {
    ImportDeclaration(path) {
      if (t.isStringLiteral(path.node.source, { value: RAX_PACKAGE })) {
        path.remove();
      }
    },
  });
}

function removeDefaultImports(ast) {
  traverse(ast, {
    ExportDefaultDeclaration(path) {
      path.remove();
    },
  });
}

function getReplacer(defaultExportedPath) {
  if (defaultExportedPath.parentPath.isExportDefaultDeclaration()) {
    /**
     * export default class {};
     */
    return defaultExportedPath.parentPath;
  } else if (defaultExportedPath.parentPath.isProgram()) {
    /**
     * class Foo {}
     * export default Foo;
     */
    return defaultExportedPath;
  } else if (defaultExportedPath.parentPath.isVariableDeclarator()) {
    /**
     * var Foo = class {}
     * export default Foo;
     */
    return defaultExportedPath.parentPath.parentPath;
  } else {
    return null;
  }
}

function transformHooks(root) {
  let ret = {};
  traverse(root, {
    CallExpression(path) {
      const { node } = path;
      if (t.isIdentifier(node.callee, { name: USE_STATE })) {
        if (t.isVariableDeclarator(path.parentPath.node) && t.isArrayPattern(path.parentPath.node.id)) {
          const firstId = path.parentPath.node.id.elements[0];
          node.arguments[1] = t.stringLiteral(firstId.name);
          ret[USE_STATE] = true;
        } else {
          console.warn(`useState should be called with following: const [foo, setFoo] = useState(originalFoo); instead of ${genExpression(path.parentPath.node)}`);
        }
      } else if (t.isIdentifier(node.callee, { name: USE_EFFECT })) {
        ret[USE_EFFECT] = true;
      }
    }
  });

  return Object.keys(ret);
}

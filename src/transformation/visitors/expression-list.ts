import assert = require("assert");
import * as ts from "typescript";
import * as lua from "../../LuaAST";
import { TransformationContext, tempSymbolId } from "../context";
import { LuaLibFeature, transformLuaLibFunction } from "../utils/lualib";
import { transformInPrecedingStatementScope } from "../utils/preceding-statements";
import { isConstIdentifier } from "../utils/typescript";
import { isOptionalContinuation } from "./optional-chaining";
import { ContextType, getFunctionContextType } from "../utils/function-context";

export function shouldMoveToTemp(context: TransformationContext, expression: lua.Expression, tsOriginal?: ts.Node) {
    return (
        !lua.isLiteral(expression) &&
        !(lua.isIdentifier(expression) && expression.symbolId === tempSymbolId) && // Treat generated temps as consts
        !(
            tsOriginal &&
            (isConstIdentifier(context, tsOriginal) ||
                isOptionalContinuation(tsOriginal) ||
                tsOriginal.kind === ts.SyntaxKind.ThisKeyword)
        )
    );
}

// Cache an expression in a preceding statement and return the temp identifier
export function moveToPrecedingTemp(
    context: TransformationContext,
    expression: lua.Expression,
    tsOriginal?: ts.Node
): lua.Expression {
    if (!shouldMoveToTemp(context, expression, tsOriginal)) {
        return expression;
    }
    const tempIdentifier = context.createTempNameForLuaExpression(expression);
    const tempDeclaration = lua.createVariableDeclarationStatement(tempIdentifier, expression, tsOriginal);
    context.addPrecedingStatements(tempDeclaration);
    return lua.cloneIdentifier(tempIdentifier, tsOriginal);
}

interface MultiType extends ts.Type {
    types: MultiType[];
    intrinsicName: string;
}

function resolveSignatureTypeByExpressionType(signatureType: MultiType): ts.Type {
    if (!signatureType.types) return signatureType;
    else {
        if (signatureType.types.length === 2 && signatureType.types[0].intrinsicName === "undefined") {
            return signatureType.types[1];
        }
        /* todo: resolve >= 2 available types */
        /* for (const sType of signatureType.types) {
            if (expressionType === sType) return sType;
        } */
    }
    return signatureType;
}

function isParamIsCallbackAndNeedWrap(
    context: TransformationContext,
    param: ts.Expression,
    signatureParameter: ts.Symbol
): boolean {
    if (signatureParameter.valueDeclaration) {
        const fromType = context.checker.getTypeAtLocation(param);
        let toType = context.checker.getTypeAtLocation(signatureParameter.valueDeclaration);
        toType = resolveSignatureTypeByExpressionType(toType as MultiType);

        // const toName = signatureParameter?.name
        const fromContext = getFunctionContextType(context, fromType);
        const toContext = getFunctionContextType(context, toType);

        if (!(fromContext === ContextType.Mixed || toContext === ContextType.Mixed)) {
            if (fromContext !== toContext) {
                if (fromContext !== ContextType.None && toContext !== ContextType.None) {
                    if (toContext === ContextType.Void) {
                        return true;
                    }
                }
                // context.diagnostics.push(unsupportedNoSelfFunctionConversion(param, toName));
                // context.diagnostics.push(unsupportedSelfFunctionConversion(param, toName));
            }
        } else {
            // context.diagnostics.push(unsupportedOverloadAssignment(param, toName));
        }
    }
    return false;
}

function transformExpressions(
    context: TransformationContext,
    expressions: readonly ts.Expression[],
    signature?: ts.Signature
): {
    transformedExpressions: lua.Expression[];
    precedingStatements: lua.Statement[][];
    lastPrecedingStatementsIndex: number;
} {
    const precedingStatements: lua.Statement[][] = [];
    const transformedExpressions: lua.Expression[] = [];
    let lastPrecedingStatementsIndex = -1;
    for (let i = 0; i < expressions.length; ++i) {
        if (signature && signature.parameters.length >= expressions.length) {
            const signatureParameter = signature.parameters[i];
            if (signatureParameter && isParamIsCallbackAndNeedWrap(context, expressions[i], signatureParameter)) {
                const { precedingStatements: expressionPrecedingStatements, result: expression } = {
                    precedingStatements: [],
                    result: transformLuaLibFunction(
                        context,
                        LuaLibFeature.FunctionWrap,
                        expressions[i].parent,
                        ...transformExpressionList(context, [expressions[i], ts.factory.createThis()])
                    ),
                };
                transformedExpressions.push(expression);
                if (expressionPrecedingStatements.length > 0) {
                    lastPrecedingStatementsIndex = i;
                }
                precedingStatements.push(expressionPrecedingStatements);
                continue;
            }
        }

        const { precedingStatements: expressionPrecedingStatements, result: expression } =
            transformInPrecedingStatementScope(context, () => context.transformExpression(expressions[i]));
        transformedExpressions.push(expression);
        if (expressionPrecedingStatements.length > 0) {
            lastPrecedingStatementsIndex = i;
        }
        precedingStatements.push(expressionPrecedingStatements);
    }
    return { transformedExpressions, precedingStatements, lastPrecedingStatementsIndex };
}

function transformExpressionsUsingTemps(
    context: TransformationContext,
    expressions: readonly ts.Expression[],
    transformedExpressions: lua.Expression[],
    precedingStatements: lua.Statement[][],
    lastPrecedingStatementsIndex: number
) {
    for (let i = 0; i < transformedExpressions.length; ++i) {
        context.addPrecedingStatements(precedingStatements[i]);
        if (i < lastPrecedingStatementsIndex) {
            transformedExpressions[i] = moveToPrecedingTemp(context, transformedExpressions[i], expressions[i]);
        }
    }
    return transformedExpressions;
}

function pushToSparseArray(
    context: TransformationContext,
    arrayIdentifier: lua.Identifier | undefined,
    expressions: lua.Expression[]
) {
    if (!arrayIdentifier) {
        arrayIdentifier = lua.createIdentifier(context.createTempName("array"));
        const libCall = transformLuaLibFunction(context, LuaLibFeature.SparseArrayNew, undefined, ...expressions);
        const declaration = lua.createVariableDeclarationStatement(arrayIdentifier, libCall);
        context.addPrecedingStatements(declaration);
    } else {
        const libCall = transformLuaLibFunction(
            context,
            LuaLibFeature.SparseArrayPush,
            undefined,
            arrayIdentifier,
            ...expressions
        );
        context.addPrecedingStatements(lua.createExpressionStatement(libCall));
    }
    return arrayIdentifier;
}

function transformExpressionsUsingSparseArray(
    context: TransformationContext,
    expressions: readonly ts.Expression[],
    transformedExpressions: lua.Expression[],
    precedingStatements: lua.Statement[][]
) {
    let arrayIdentifier: lua.Identifier | undefined;

    let expressionBatch: lua.Expression[] = [];
    for (let i = 0; i < expressions.length; ++i) {
        // Expressions with preceding statements should always be at the start of a batch
        if (precedingStatements[i].length > 0 && expressionBatch.length > 0) {
            arrayIdentifier = pushToSparseArray(context, arrayIdentifier, expressionBatch);
            expressionBatch = [];
        }

        context.addPrecedingStatements(precedingStatements[i]);
        expressionBatch.push(transformedExpressions[i]);

        // Spread expressions should always be at the end of a batch
        if (ts.isSpreadElement(expressions[i])) {
            arrayIdentifier = pushToSparseArray(context, arrayIdentifier, expressionBatch);
            expressionBatch = [];
        }
    }

    if (expressionBatch.length > 0) {
        arrayIdentifier = pushToSparseArray(context, arrayIdentifier, expressionBatch);
    }

    assert(arrayIdentifier);
    return [transformLuaLibFunction(context, LuaLibFeature.SparseArraySpread, undefined, arrayIdentifier)];
}

function countNeededTemps(
    context: TransformationContext,
    expressions: readonly ts.Expression[],
    transformedExpressions: lua.Expression[],
    lastPrecedingStatementsIndex: number
) {
    if (lastPrecedingStatementsIndex < 0) {
        return 0;
    }
    return transformedExpressions
        .slice(0, lastPrecedingStatementsIndex)
        .filter((e, i) => shouldMoveToTemp(context, e, expressions[i])).length;
}

// Transforms a list of expressions while flattening spreads and maintaining execution order
export function transformExpressionList(
    context: TransformationContext,
    expressions: readonly ts.Expression[],
    signature?: ts.Signature
): lua.Expression[] {
    const { transformedExpressions, precedingStatements, lastPrecedingStatementsIndex } = transformExpressions(
        context,
        expressions,
        signature
    );

    // If more than this number of temps are required to preserve execution order, we'll fall back to using the
    // sparse array lib functions instead to prevent excessive locals.
    const maxTemps = 2;

    // Use sparse array lib if there are spreads before the last expression
    // or if too many temps are needed to preserve order
    const lastSpread = expressions.findIndex(e => ts.isSpreadElement(e));
    if (
        (lastSpread >= 0 && lastSpread < expressions.length - 1) ||
        countNeededTemps(context, expressions, transformedExpressions, lastPrecedingStatementsIndex) > maxTemps
    ) {
        return transformExpressionsUsingSparseArray(context, expressions, transformedExpressions, precedingStatements);
    } else {
        return transformExpressionsUsingTemps(
            context,
            expressions,
            transformedExpressions,
            precedingStatements,
            lastPrecedingStatementsIndex
        );
    }
}

// Transforms a series of expressions while maintaining execution order
export function transformOrderedExpressions(
    context: TransformationContext,
    expressions: readonly ts.Expression[]
): lua.Expression[] {
    const { transformedExpressions, precedingStatements, lastPrecedingStatementsIndex } = transformExpressions(
        context,
        expressions
    );
    return transformExpressionsUsingTemps(
        context,
        expressions,
        transformedExpressions,
        precedingStatements,
        lastPrecedingStatementsIndex
    );
}

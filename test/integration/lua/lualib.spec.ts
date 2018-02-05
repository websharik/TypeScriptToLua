import { Expect, Test, TestCase } from "alsatian";

import * as ts from "typescript";
import {LuaTranspiler, TranspileError} from "../../../dist/Transpiler";

const LuaVM = require("lua.vm.js");
const fs = require("fs");

const dummyArrayType = { flags: ts.TypeFlags.Object, symbol: {escapedName: "Array"}};
let dummyType = {};
const dummyChecker = {getTypeAtLocation: function() {return dummyType;}}
function transpileString(str: string): string {
    const file = ts.createSourceFile("", str, ts.ScriptTarget.Latest);
    const result = LuaTranspiler.transpileSourceFile(file, dummyChecker, false);
    return result.trim();
}
function executeLua(lua: string): string {
    const luavm = new LuaVM.Lua.State();
    return luavm.execute(lua)[0];
}

const lualib = fs.readFileSync("dist/lualib/typescript.lua") + "\n";

const toStringDef = "function ToString(list)\n"+
    "local result = \"\"\n" +
    "for i=1,#list do result = result .. list[i]\n" +
    "if i < #list then result = result .. ',' end end\n"+
    "return result end\n";

export class LuaTests {

    @TestCase([0,1,2,3], 1, 2)
    @TestCase([0,1,2,3], 1, 1)
    @TestCase([0,1,2,3], 1, -1)
    @TestCase([0,1,2,3], -3, -1)
    @TestCase([0,1,2,3,4,5], 1, 3)
    @TestCase([0,1,2,3,4,5], 3)
    @Test("array.slice")
    public slice<T>(inp: T[], start: number, end?: number) {
        // Make typechecker return array type
        dummyType = dummyArrayType;
        // Transpile
        let lua = transpileString(`return ToString([${inp.toString()}].slice(${start}, ${end}))`);

        // Add library
        lua = toStringDef + lualib + lua;

        // Execute
        let result = executeLua(lua);

        // Assert
        Expect(result).toBe(inp.slice(start, end).toString());
    }

    @TestCase([0,1,2,3], 1, 0, 9, 10, 11)
    @TestCase([0,1,2,3], 2, 2, 9, 10, 11)
    @TestCase([0,1,2,3], 4, 1, 8, 9)
    @TestCase([0,1,2,3], 4, 0, 8, 9)
    @TestCase([0,1,2,3,4,5], 5, 9, 10, 11)
    @TestCase([0,1,2,3,4,5], 3, 2, 3, 4, 5)
    @Test("array.splice[Insert]")
    public spliceInsert<T>(inp: T[], start: number, deleteCount: number, ...newElements: any[]) {
        // Make typechecker return array type
        dummyType = dummyArrayType;
        // Transpile
        let lua = transpileString(
            `let spliceTestTable = [${inp.toString()}]
            spliceTestTable.splice(${start}, ${deleteCount}, ${newElements});
            return ToString(spliceTestTable);`
        );

        // Add library
        lua = toStringDef + lualib + lua;

        // Execute
        let result = executeLua(lua);

        // Assert
        inp.splice(start, deleteCount, ...newElements)
        Expect(result).toBe(inp.toString());
    }

    @TestCase([0,1,2,3], 1, 1)
    @TestCase([0,1,2,3], 10, 1)
    @TestCase([0,1,2,3], 4)
    @TestCase([0,1,2,3,4,5], 3)
    @TestCase([0,1,2,3,4,5], 2, 2)
    @TestCase([0,1,2,3,4,5,6,7,8], 5, 9, 10, 11)
    @Test("array.splice[Remove]")
    public spliceRemove<T>(inp: T[], start: number, deleteCount?: number, ...newElements: any[]) {
        // Make typechecker return array type
        dummyType = dummyArrayType;
        // Transpile
        let lua = transpileString(`return ToString([${inp.toString()}].splice(${start}, ${deleteCount}, ${newElements}))`);

        // Add library
        lua = toStringDef + lualib + lua;

        // Execute
        let result = executeLua(lua);

        // Assert
        if (deleteCount) {
            Expect(result).toBe(inp.splice(start, deleteCount, ...newElements).toString());
        } else {
            Expect(result).toBe(inp.splice(start).toString());
        }
    }
}

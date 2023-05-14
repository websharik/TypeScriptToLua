export function __TS__FunctionWrap(
    this: void,
    fn: (this: void, ...argArray: any[]) => any,
    boundTo?: any
): (this: void, ...args: any[]) => any {
    if (boundTo && typeof boundTo === "object") {
        const address = tostring(fn);
        if (!boundTo.__TS__wrappedMethods) boundTo.__TS__wrappedMethods = {};
        if (!boundTo.__TS__wrappedMethods[address]) {
            boundTo.__TS__wrappedMethods[address] = function (this: void, ...args: any[]) {
                return fn(boundTo, ...args);
            };
        }
        return boundTo.__TS__wrappedMethods[address];
    } else {
        return (...args: any[]) => fn(boundTo, ...args);
    }
}

export function redirect(u) { throw new Error("REDIRECT:" + u); }
export function notFound() { throw new Error("NOT_FOUND"); }

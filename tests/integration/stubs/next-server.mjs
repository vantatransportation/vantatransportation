export class NextResponse extends Response {
  constructor(body, init) { super(body, init); this._cookies = []; this.cookies = { set: (...a) => this._cookies.push(a) }; }
  static json(data, init = {}) { return new NextResponse(JSON.stringify(data), { ...init, headers: { "content-type": "application/json" } }); }
  static redirect(url, status = 307) { const r = new NextResponse(null, { status, headers: { location: String(url) } }); return r; }
}

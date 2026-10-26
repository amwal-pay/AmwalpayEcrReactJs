/** An HTTP response, built by the API and sent by the front controller. */
export class Response {
  constructor(status, headers = {}, body = '') {
    this.status = status;
    this.headers = headers;
    this.body = body;
  }

  static json(status, data) {
    return new Response(status, { 'Content-Type': 'application/json; charset=utf-8' }, JSON.stringify(data));
  }

  static empty(status) {
    return new Response(status);
  }

  /** Writes this response to a Node `http.ServerResponse`. */
  send(res) {
    res.writeHead(this.status, this.headers);
    res.end(this.body);
  }
}

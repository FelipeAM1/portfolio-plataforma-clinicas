export class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function reject(status, message) {
  throw new RequestError(status, message);
}

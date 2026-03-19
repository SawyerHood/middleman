type RequestKey<RequestMap extends Record<string, unknown>> = Extract<keyof RequestMap, string>;

interface PendingRequest<T> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export class WsRequestTracker<RequestMap extends Record<string, unknown>> {
  private readonly pendingByType = new Map<
    RequestKey<RequestMap>,
    Map<string, PendingRequest<unknown>>
  >();

  constructor(
    private readonly requestTypes: readonly RequestKey<RequestMap>[],
    private readonly timeoutMs: number,
  ) {
    for (const requestType of requestTypes) {
      this.pendingByType.set(requestType, new Map());
    }
  }

  track<RequestType extends RequestKey<RequestMap>>(
    requestType: RequestType,
    requestId: string,
    resolve: (value: RequestMap[RequestType]) => void,
    reject: (error: Error) => void,
  ): void {
    const timeout = setTimeout(() => {
      this.reject(
        requestType,
        requestId,
        new Error("Request timed out waiting for backend response."),
      );
    }, this.timeoutMs);

    this.pendingMapFor(requestType).set(requestId, {
      resolve,
      reject,
      timeout,
    });
  }

  resolve<RequestType extends RequestKey<RequestMap>>(
    requestType: RequestType,
    requestId: string | undefined,
    value: RequestMap[RequestType],
  ): void {
    const resolvedById = requestId ? this.resolveById(requestType, requestId, value) : false;

    if (resolvedById) {
      return;
    }

    this.resolveOldest(requestType, value);
  }

  reject<RequestType extends RequestKey<RequestMap>>(
    requestType: RequestType,
    requestId: string,
    error: Error,
  ): boolean {
    const pendingMap = this.pendingMapFor(requestType);
    const pending = pendingMap.get(requestId);
    if (!pending) {
      return false;
    }

    clearTimeout(pending.timeout);
    pendingMap.delete(requestId);
    pending.reject(error);
    return true;
  }

  rejectByRequestId(requestId: string, error: Error): boolean {
    for (const requestType of this.requestTypes) {
      if (this.reject(requestType, requestId, error)) {
        return true;
      }
    }

    return false;
  }

  rejectOldest<RequestType extends RequestKey<RequestMap>>(
    requestType: RequestType,
    error: Error,
  ): boolean {
    const pendingMap = this.pendingMapFor(requestType);
    const first = pendingMap.entries().next();
    if (first.done) {
      return false;
    }

    const [requestId, pending] = first.value;
    clearTimeout(pending.timeout);
    pendingMap.delete(requestId);
    pending.reject(error);
    return true;
  }

  rejectOnlyPending(error: Error): boolean {
    if (this.totalPending() !== 1) {
      return false;
    }

    for (const requestType of this.requestTypes) {
      if (this.rejectOldest(requestType, error)) {
        return true;
      }
    }

    return false;
  }

  rejectAll(error: Error): void {
    for (const requestType of this.requestTypes) {
      const pendingMap = this.pendingMapFor(requestType);
      for (const [requestId, pending] of pendingMap.entries()) {
        clearTimeout(pending.timeout);
        pending.reject(error);
        pendingMap.delete(requestId);
      }
    }
  }

  totalPending(): number {
    let pendingCount = 0;

    for (const requestType of this.requestTypes) {
      pendingCount += this.pendingMapFor(requestType).size;
    }

    return pendingCount;
  }

  private resolveById<RequestType extends RequestKey<RequestMap>>(
    requestType: RequestType,
    requestId: string,
    value: RequestMap[RequestType],
  ): boolean {
    const pendingMap = this.pendingMapFor(requestType);
    const pending = pendingMap.get(requestId);
    if (!pending) {
      return false;
    }

    clearTimeout(pending.timeout);
    pendingMap.delete(requestId);
    pending.resolve(value);
    return true;
  }

  private resolveOldest<RequestType extends RequestKey<RequestMap>>(
    requestType: RequestType,
    value: RequestMap[RequestType],
  ): boolean {
    const pendingMap = this.pendingMapFor(requestType);
    const first = pendingMap.entries().next();
    if (first.done) {
      return false;
    }

    const [requestId, pending] = first.value;
    clearTimeout(pending.timeout);
    pendingMap.delete(requestId);
    pending.resolve(value);
    return true;
  }

  private pendingMapFor<RequestType extends RequestKey<RequestMap>>(
    requestType: RequestType,
  ): Map<string, PendingRequest<RequestMap[RequestType]>> {
    return this.pendingByType.get(requestType) as Map<
      string,
      PendingRequest<RequestMap[RequestType]>
    >;
  }
}

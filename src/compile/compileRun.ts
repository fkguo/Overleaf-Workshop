export class CompileRunGate {
    private runState?: {token: symbol, cancelled: boolean};

    get active() {
        return this.runState !== undefined;
    }

    get cancelled() {
        return this.runState?.cancelled === true;
    }

    async run<T>(operation: (isCurrent: () => boolean) => Promise<T>): Promise<T | undefined> {
        if (this.runState) {
            return undefined;
        }
        const token = Symbol('compile-run');
        this.runState = {token, cancelled: false};
        const isCurrent = () => this.runState?.token === token && !this.runState.cancelled;
        try {
            return await operation(isCurrent);
        } finally {
            if (this.runState?.token === token) {
                this.runState = undefined;
            }
        }
    }

    cancel() {
        if (this.runState) {
            this.runState.cancelled = true;
        }
    }
}

export class SingleFlightGate {
    private operation?: Promise<void>;

    get active() {
        return this.operation !== undefined;
    }

    run(start: () => Promise<void>): Promise<void> {
        if (this.operation) {
            return this.operation;
        }
        let tracked!: Promise<void>;
        tracked = start().finally(() => {
            if (this.operation === tracked) {
                this.operation = undefined;
            }
        });
        this.operation = tracked;
        return tracked;
    }
}

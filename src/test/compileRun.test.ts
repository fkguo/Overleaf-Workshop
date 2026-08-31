import { strict as assert } from 'assert';
import { CompileRunGate, SingleFlightGate } from '../compile/compileRun';

describe('CompileRunGate', () => {
    it('releases the compile state after a failed startup attempt', async () => {
        const gate = new CompileRunGate();
        const failure = new Error('HTTP 404');

        await assert.rejects(
            gate.run(async () => { throw failure; }),
            failure,
        );
        assert.equal(gate.active, false);

        let retried = false;
        await gate.run(async () => {
            retried = true;
        });
        assert.equal(retried, true);
        assert.equal(gate.active, false);
    });

    it('does not overlap a save-triggered compile with an active compile', async () => {
        const gate = new CompileRunGate();
        let finishFirst!: () => void;
        const first = gate.run(() => new Promise<void>(resolve => {
            finishFirst = resolve;
        }));

        let secondRan = false;
        await gate.run(async () => {
            secondRan = true;
        });
        assert.equal(secondRan, false);

        finishFirst();
        await first;
        assert.equal(gate.active, false);
    });

    it('marks a stopped run stale without allowing a replacement to overlap it', async () => {
        const gate = new CompileRunGate();
        let finishFirst!: () => void;
        let firstIsCurrent!: () => boolean;
        const first = gate.run(isCurrent => new Promise<void>(resolve => {
            firstIsCurrent = isCurrent;
            finishFirst = resolve;
        }));

        gate.cancel();
        assert.equal(gate.active, true);
        assert.equal(gate.cancelled, true);
        assert.equal(firstIsCurrent(), false);

        let secondRan = false;
        await gate.run(async () => { secondRan = true; });
        assert.equal(secondRan, false);

        finishFirst();
        await first;
        assert.equal(gate.active, false);

        await gate.run(async () => { secondRan = true; });
        assert.equal(secondRan, true);
        assert.equal(gate.active, false);
    });

    it('prevents a run stopped during preparation from reaching its side effect', async () => {
        const gate = new CompileRunGate();
        let finishPreparation!: () => void;
        let sideEffectRan = false;
        const run = gate.run(async isCurrent => {
            await new Promise<void>(resolve => { finishPreparation = resolve; });
            if (!isCurrent()) { return; }
            sideEffectRan = true;
        });

        gate.cancel();
        finishPreparation();
        await run;
        assert.equal(sideEffectRan, false);
        assert.equal(gate.active, false);
    });
});

describe('SingleFlightGate', () => {
    it('shares one stop operation across repeated requests', async () => {
        const gate = new SingleFlightGate();
        let finish!: () => void;
        let starts = 0;
        const first = gate.run(() => {
            starts += 1;
            return new Promise<void>(resolve => { finish = resolve; });
        });
        const second = gate.run(async () => { starts += 1; });

        assert.equal(first, second);
        assert.equal(starts, 1);
        assert.equal(gate.active, true);
        finish();
        await first;
        assert.equal(gate.active, false);
    });
});

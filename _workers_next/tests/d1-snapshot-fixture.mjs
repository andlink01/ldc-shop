// Test-only instrumentation: commit a real delivery after the card snapshot is read.
// Both standalone reads and D1 batches are supported so the previous bug also fails.
export function interleaveSnapshotReads(database, mutate) {
    const statements = new WeakMap()
    let interleaved = false
    const afterRead = async () => {
        if (interleaved) return
        interleaved = true
        await mutate()
    }
    const prepare = (statement, query) => {
        const cards = /^select\b/i.test(query) && /\bfrom\s+["`]?cards["`]?\s*$/i.test(query)
        const read = async (method, args) => {
            const result = await statement[method](...args)
            if (cards) await afterRead()
            return result
        }
        const traced = {
            bind: (...args) => prepare(statement.bind(...args), query),
            first: (...args) => statement.first(...args),
            run: (...args) => statement.run(...args),
            all: (...args) => read('all', args),
            raw: (...args) => read('raw', args),
        }
        statements.set(traced, { statement, cards })
        return traced
    }
    return {
        didInterleave: () => interleaved,
        database: {
            prepare: query => prepare(database.prepare(query), query),
            batch: async queries => {
                const result = await database.batch(queries.map(query => statements.get(query)?.statement ?? query))
                if (queries.some(query => statements.get(query)?.cards)) await afterRead()
                return result
            },
            exec: (...args) => database.exec(...args),
            dump: (...args) => database.dump(...args),
        },
    }
}

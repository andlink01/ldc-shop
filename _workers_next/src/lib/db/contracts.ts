export interface SqlStatement {
    sql: string
    params: Array<string | number | null>
}

export interface RawResult<T = Record<string, unknown>> {
    results: T[]
    meta?: { changes?: number; last_row_id?: number }
}

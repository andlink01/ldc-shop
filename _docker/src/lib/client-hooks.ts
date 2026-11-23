'use client'

import { useState, useSyncExternalStore, type Dispatch, type SetStateAction } from 'react'

const subscribeHydration = () => () => {}
export function useHydrated() {
    return useSyncExternalStore(subscribeHydration, () => true, () => false)
}

export function usePropState<T>(source: T): [T, Dispatch<SetStateAction<T>>] {
    const [state, setState] = useState({ source, value: source })
    if (!Object.is(state.source, source)) setState({ source, value: source })
    const value = Object.is(state.source, source) ? state.value : source
    const update: Dispatch<SetStateAction<T>> = next => setState(current => ({ source,
        value: typeof next === 'function' ? (next as (value: T) => T)(current.value) : next }))
    return [value, update]
}

type PurchaseQuestion = { q: string; a: string }

function readQuestions(raw: string | null | undefined): PurchaseQuestion[] | null {
    if (!raw) return []
    try {
        const parsed: unknown = JSON.parse(raw)
        if (!Array.isArray(parsed) || !parsed.every(question => question && typeof question === 'object'
            && typeof question.q === 'string' && question.q.trim()
            && typeof question.a === 'string' && question.a.trim())) return null
        return parsed as PurchaseQuestion[]
    } catch { return null }
}

export function publicPurchaseQuestions(raw: string | null | undefined): string | null {
    const questions = readQuestions(raw)
    return questions?.length ? JSON.stringify(questions.map(({ q }) => ({ q }))) : null
}

export function validatePurchaseAnswers(raw: string | null | undefined, answers: unknown): string | null {
    const questions = readQuestions(raw)
    if (!questions) return 'buy.questionsUnavailable'
    if (!questions.length) return null
    if (!Array.isArray(answers) || answers.length !== questions.length
        || questions.some((_, index) => typeof answers[index] !== 'string')) return 'buy.answersRequired'
    return questions.every((question, index) => answers[index].trim().toLowerCase() === question.a.trim().toLowerCase())
        ? null : 'buy.questionsWrong'
}

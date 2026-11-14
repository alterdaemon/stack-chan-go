// USB-only preference overlay. No writes, arbitrary text, credentials or fallback.
export function trialPreferences(getPreference, trials) {
  if (!trials) return getPreference
  return (domain, key) => {
    if (domain === 'openailive') {
      if (key === 'auth' && ['api-live', 'chatgpt'].includes(trials.connection))
        return trials.connection === 'api-live' ? 'api-key' : 'chatgpt'
      if (key === 'mode' && trials.connection === 'api-live') return 'live'
      if (key === 'codexModel' && trials.model !== undefined) return trials.model
      if (key === 'codexEffort' && trials.effort !== undefined) return trials.effort
      const name = key === 'standbySeconds' ? 'standby' : key
      if (['pitch', 'style', 'standby'].includes(name) && trials[name] !== undefined) return trials[name]
    }
    if (domain === 'tts' && key === 'volume' && trials.volume !== undefined) return trials.volume
    if (domain === 'ai' && key === 'context' && trials.prompt !== undefined)
      return trials.prompt === 'long' ? 'Speak briefly and naturally. '.repeat(180) : 'Speak briefly and naturally.'
    return getPreference(domain, key)
  }
}

export function trialInput(trials) {
  const language = trials?.prompt
  if (!['english', 'polish'].includes(language)) return undefined
  return [
    {
      type: 'message',
      role: 'user',
      content: [
        {
          type: 'input_text',
          text:
            language === 'english'
              ? 'Say exactly: Hello. This is a voice test.'
              : 'Powiedz dokładnie: Cześć. To jest test głosu.',
        },
      ],
    },
  ]
}

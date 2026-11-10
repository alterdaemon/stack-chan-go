import { Bluetooth, Info, Save, Trash2, Unplug, Wifi } from 'lucide-react'
import { useState, type ComponentProps, type ReactNode } from 'react'

import { useI18n } from '@/app/i18n-provider'
import { OperationStatus } from '@/components/stackchan/operation-status'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import {
  OPENAI_REASONING_EFFORTS,
  OPENAI_LIVE_VOICES,
  OPENAI_REALTIME_VOICES,
  OPENAI_LIVE_PITCH_MIN,
  OPENAI_LIVE_PITCH_MAX,
  OPENAI_LIVE_STANDBY_MIN,
  OPENAI_LIVE_STANDBY_MAX,
  type PreferenceKey,
} from '@/features/preferences/preference-model'
import { usePreferences } from '@/features/preferences/use-preferences'

type FieldProps = Omit<ComponentProps<'input'>, 'id' | 'name' | 'value' | 'disabled' | 'onChange'> & {
  name: PreferenceKey
  label: string
  wide?: boolean
}

export function PreferencesPage() {
  const { t } = useI18n()
  const preferences = usePreferences()
  const [clearDialogOpen, setClearDialogOpen] = useState(false)
  const isDisabled = (name: PreferenceKey) =>
    !preferences.connected ||
    preferences.readOnly.has(name) ||
    (name.startsWith('openailive.') && !preferences.openaiAvailable) ||
    (name === 'openailive.mode' && !preferences.modeAvailable) ||
    (name === 'openailive.realtimeVoice' && !preferences.realtimeVoiceAvailable) ||
    (name === 'openailive.bargeIn' && !preferences.bargeInAvailable) ||
    (name === 'openailive.voice' && !preferences.voiceAvailable) ||
    (name === 'openailive.pitch' && !preferences.pitchAvailable) ||
    (name === 'openailive.style' && !preferences.styleAvailable) ||
    (name === 'openailive.standbySeconds' && !preferences.standbyAvailable) ||
    (name === 'www.password' && !preferences.wwwAvailable)

  const inputField = ({ name, label, type = 'text', wide, ...props }: FieldProps) => (
    <div className={wide ? 'grid gap-2 sm:col-span-2' : 'grid gap-2'}>
      <Label htmlFor={name}>{t(label)}</Label>
      <Input
        id={name}
        name={name}
        type={type}
        value={preferences.values[name]}
        disabled={isDisabled(name)}
        onChange={(event) => preferences.update(name, event.target.value)}
        {...props}
      />
    </div>
  )

  const selectField = (
    name: PreferenceKey,
    label: string,
    options: readonly { value: string; label: string; translate?: boolean }[],
    hint?: string,
    wide = false
  ) => (
    <div className={wide ? 'grid gap-2 sm:col-span-2' : 'grid gap-2'}>
      <Label htmlFor={name}>{t(label)}</Label>
      <Select
        items={options.map((option) => ({
          value: option.value,
          label: option.translate === false ? option.label : t(option.label),
        }))}
        value={preferences.values[name]}
        disabled={isDisabled(name)}
        onValueChange={(value) => value && preferences.update(name, value)}
      >
        <SelectTrigger id={name} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              <span translate={option.translate === false ? 'no' : undefined}>
                {option.translate === false ? option.label : t(option.label)}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {hint && <p className="text-xs leading-5 text-muted-foreground">{t(hint)}</p>}
    </div>
  )

  const section = (title: string, children: ReactNode) => (
    <Card>
      <CardHeader>
        <CardTitle>{t(title)}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-2">{children}</CardContent>
    </Card>
  )

  return (
    <>
      <div className="page-container grid items-start gap-6 lg:grid-cols-[17rem_minmax(0,1fr)]">
        <aside className="grid gap-4 lg:sticky lg:top-22">
          <Card>
            <CardHeader>
              <CardTitle>{t('本体設定')}</CardTitle>
              <CardDescription>
                {t(preferences.http ? 'Wi-Fiでｽﾀｯｸﾁｬﾝに接続します。' : 'BLEでｽﾀｯｸﾁｬﾝに接続します。')}
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3">
              <Alert role="note">
                <Info aria-hidden="true" />
                <AlertDescription>
                  {t(
                    preferences.http
                      ? '初回は本体の設定画面を開き、末尾のWWWでパスワードを設定してください。設定変更は再起動後に反映されます。'
                      : '接続する前に、ｽﾀｯｸﾁｬﾝの起動画面で「設定」を押し、本体の設定画面を開いてください。'
                  )}
                </AlertDescription>
              </Alert>
              {preferences.connected ? (
                <Button variant="destructive" onClick={() => void preferences.disconnect()} disabled={preferences.busy}>
                  <Unplug data-icon="inline-start" />
                  {t('切断')}
                </Button>
              ) : (
                <Button onClick={() => void preferences.connect()} disabled={preferences.busy}>
                  {preferences.http ? <Wifi data-icon="inline-start" /> : <Bluetooth data-icon="inline-start" />}
                  {t(
                    preferences.connection === 'connecting' ? '接続中…' : preferences.http ? 'Wi-Fiで接続' : 'BLEで接続'
                  )}
                </Button>
              )}
              <p className="text-sm text-muted-foreground" role="status">
                {t(preferences.connected ? '接続済み' : '未接続')}
              </p>
            </CardContent>
          </Card>
          <OperationStatus
            state={preferences.operation}
            labels={{
              pending: t('処理中'),
              success: t('設定を更新しました'),
              cancelled: t('お知らせ'),
              error: t('設定操作に失敗しました'),
            }}
          />
        </aside>

        <form
          className="grid min-w-0 gap-5"
          aria-label={t('設定項目')}
          onSubmit={(event) => {
            event.preventDefault()
            void preferences.save()
          }}
        >
          {section(
            'Wi-Fi',
            <>
              {inputField({ name: 'wifi.ssid', label: 'SSID', autoComplete: 'off' })}
              {inputField({
                name: 'wifi.password',
                label: 'パスワード',
                type: 'password',
                autoComplete: 'off',
              })}
              <div className="sm:col-span-2">
                <Button
                  type="button"
                  variant="destructive"
                  disabled={isDisabled('wifi.ssid') || isDisabled('wifi.password') || preferences.busy}
                  onClick={() => setClearDialogOpen(true)}
                >
                  <Trash2 data-icon="inline-start" />
                  {t('Wi-Fi設定を消去')}
                </Button>
              </div>
            </>
          )}
          {section(
            '外観',
            <>
              {selectField('ui.type', '顔の種類', [
                { value: 'simple', label: 'シンプル' },
                { value: 'dog', label: 'いぬ' },
              ])}
              {selectField('ui.language', '本体の表示言語', [
                { value: 'ja', label: '日本語', translate: false },
                { value: 'en', label: 'English', translate: false },
                { value: 'zh-CN', label: '简体中文', translate: false },
              ])}
            </>
          )}
          {section(
            'サーボ',
            <>
              {selectField(
                'driver.type',
                'ドライバー',
                [
                  { value: 'm5stackchan', label: 'M5StackChan Servo（CoreS3専用・推奨）' },
                  { value: 'scservo', label: 'SCServo（汎用・外部配線向け）' },
                  { value: 'dynamixel', label: 'Dynamixel（Protocol 2）' },
                  { value: 'rs30x', label: 'RS30X' },
                  { value: 'pwm', label: 'PWM（SG-90）' },
                  { value: 'none', label: 'なし' },
                ],
                'M5StackChan Servoは専用UART、ゼロ位置、可動域、PY32サーボ電源を設定します。CoreS3専用ファームウェアではこの項目に固定されます。',
                true
              )}
              {inputField({ name: 'driver.offsetPan', label: 'パン オフセット', type: 'number' })}
              {inputField({ name: 'driver.offsetTilt', label: 'チルト オフセット', type: 'number' })}
            </>
          )}
          {section(
            '音声合成',
            <>
              {selectField('tts.type', 'サービス', [
                { value: 'voicevox', label: 'VOICEVOX', translate: false },
                { value: 'elevenlabs', label: 'ElevenLabs', translate: false },
                { value: 'google-tts', label: 'Google TTS', translate: false },
                { value: 'openai', label: 'OpenAI', translate: false },
                { value: 'local', label: 'ローカル' },
              ])}
              {inputField({ name: 'tts.host', label: 'ホスト', placeholder: 'my-tts-host.local' })}
              {inputField({ name: 'tts.port', label: 'ポート', type: 'number', placeholder: '50021' })}
              {inputField({ name: 'tts.voice', label: '音声', placeholder: 'ally' })}
              {inputField({ name: 'tts.token', label: 'トークン', type: 'password' })}
              {inputField({
                name: 'tts.volume',
                label: '音量（0–1）',
                type: 'number',
                step: '0.1',
                min: '0',
                max: '1',
              })}
            </>
          )}
          {section(
            'AI',
            <>
              {inputField({ name: 'ai.token', label: 'トークン', type: 'password' })}
              <div className="grid gap-2 sm:col-span-2">
                <Label htmlFor="ai.context">{t('システムロール')}</Label>
                <Textarea
                  id="ai.context"
                  rows={5}
                  value={preferences.values['ai.context']}
                  disabled={!preferences.connected || preferences.readOnly.has('ai.context')}
                  placeholder="You are Stack-chan（スタックチャン）, the palm sized super kawaii companion robot."
                  onChange={(event) => preferences.update('ai.context', event.target.value)}
                />
              </div>
            </>
          )}
          {section(
            'OpenAI',
            <>
              {selectField(
                'openailive.mode',
                '会話モード',
                [
                  { value: 'live', label: 'GPT-Live 1', translate: false },
                  { value: 'realtime', label: 'GPT-Realtime 2.1 Mini', translate: false },
                ],
                'モードは次回のLIVE開始時に適用されます。',
                true
              )}
              {preferences.values['openailive.mode'] === 'realtime' && (
                <p className="text-xs leading-5 text-muted-foreground sm:col-span-2">
                  {t('Realtime Miniは無音でも接続を維持します。モデルと推論の強度は検索に使用します。')}
                </p>
              )}
              {inputField({ name: 'openailive.backendModel', label: 'モデル', required: true, pattern: '.*\\S.*' })}
              {selectField(
                'openailive.reasoningEffort',
                '推論の強度',
                OPENAI_REASONING_EFFORTS.map((value) => ({ value, label: value, translate: false }))
              )}
              {selectField(
                preferences.values['openailive.mode'] === 'realtime' ? 'openailive.realtimeVoice' : 'openailive.voice',
                '声',
                (preferences.values['openailive.mode'] === 'realtime'
                  ? OPENAI_REALTIME_VOICES
                  : OPENAI_LIVE_VOICES
                ).map((value) => ({ value, label: value, translate: false }))
              )}
              <div className="grid gap-2">
                <div className="flex items-center justify-between gap-3">
                  <Label htmlFor="openailive.pitch">{t('ピッチ')}</Label>
                  <output htmlFor="openailive.pitch" className="text-sm tabular-nums">
                    {Number(preferences.values['openailive.pitch']) > 0 ? '+' : ''}
                    {preferences.values['openailive.pitch']} {t('半音')}
                  </output>
                </div>
                <input
                  id="openailive.pitch"
                  name="openailive.pitch"
                  type="range"
                  min={OPENAI_LIVE_PITCH_MIN}
                  max={OPENAI_LIVE_PITCH_MAX}
                  step="1"
                  className="w-full accent-primary disabled:opacity-50"
                  value={preferences.values['openailive.pitch']}
                  disabled={isDisabled('openailive.pitch')}
                  onChange={(event) => preferences.update('openailive.pitch', event.target.value)}
                />
              </div>
              {selectField(
                'openailive.style',
                '話し方',
                [
                  { value: 'default', label: '標準' },
                  { value: 'calm', label: '穏やか' },
                  { value: 'expressive', label: '表情豊か' },
                ],
                '声・ピッチ・話し方は次回のLIVE開始時に適用されます。',
                true
              )}
              {selectField(
                'openailive.bargeIn',
                '音声で割り込み（実験的）',
                [
                  { value: '0', label: '無効' },
                  { value: '1', label: '有効' },
                ],
                '発話中も音声を聞き取り、選択したモードで割り込みに対応します。初期設定は無効です。次回のLIVE開始時に適用されます。',
                true
              )}
              {preferences.values['openailive.mode'] !== 'realtime' && (
                <>
                  {inputField({
                    name: 'openailive.standbySeconds',
                    label: '自動切断までの秒数',
                    type: 'number',
                    min: OPENAI_LIVE_STANDBY_MIN,
                    max: OPENAI_LIVE_STANDBY_MAX,
                    step: 1,
                    required: true,
                  })}
                  <p className="text-xs leading-5 text-muted-foreground sm:col-span-2">
                    {t(
                      'ロボットが話さないと自動切断します。別モデルへの応答待ち中は停止します。初期値は60秒。次回のGPT-Live開始時に適用されます。'
                    )}
                  </p>
                </>
              )}
            </>
          )}
          {section(
            'MCP Server',
            <>{inputField({ name: 'mcp.token', label: 'Bearerトークン', type: 'password', wide: true })}</>
          )}
          {section(
            'WWW',
            <>
              {inputField({
                name: 'www.password',
                label: 'Wi-Fiアクセスパスワード',
                type: 'password',
                autoComplete: 'new-password',
                wide: true,
              })}
              <p className="text-xs leading-5 text-muted-foreground sm:col-span-2">
                {t('ログイン名は任意です。空欄の場合、現在のパスワードを変更しません。')}
              </p>
            </>
          )}
          <footer className="sticky bottom-0 z-10 flex justify-end border-t bg-background/95 py-3 backdrop-blur">
            <Button type="submit" disabled={!preferences.connected || preferences.busy}>
              <Save data-icon="inline-start" />
              {t('設定を保存')}
            </Button>
          </footer>
        </form>
      </div>

      <AlertDialog open={clearDialogOpen} onOpenChange={setClearDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('Wi-Fi設定を消去しますか？')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('保存済みのSSIDとパスワードを消去します。次回はオフラインで起動します。')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('キャンセル')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setClearDialogOpen(false)
                void preferences.clearWifi()
              }}
            >
              {t('消去する')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

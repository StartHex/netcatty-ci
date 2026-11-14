/**
 * Form fields of the on-host database kind: which SSH host the driver runs on,
 * how it finds the database there, and what has to be typed on the way to the
 * host's shell (a bastion's "enter the address, pick the account" menu).
 * Presentation only; the dialog owns the state.
 */

import { Plus, X } from 'lucide-react';
import React from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import {
  addOnHostLoginStep,
  canAddOnHostLoginStep,
  removeOnHostLoginStep,
  updateOnHostLoginStep,
  type OnHostFormProblem,
  type OnHostFormValue,
} from '../../domain/database/onHostForm';
import {
  ON_HOST_DATABASE_MODES,
  ON_HOST_DATABASE_TYPES,
  type OnHostDatabaseMode,
  type OnHostDatabaseType,
} from '../../domain/models';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';

export interface OnHostConnectionFieldsProps {
  value: OnHostFormValue;
  sshHostId: string;
  sshHosts: { id: string; label: string }[];
  /** What keeps the form from being saved; shown once the user tried to. */
  problem: OnHostFormProblem | null;
  showError: boolean;
  onChange: (patch: Partial<OnHostFormValue>) => void;
  onHostChange: (hostId: string) => void;
}

export const OnHostConnectionFields: React.FC<OnHostConnectionFieldsProps> = ({
  value,
  sshHostId,
  sshHosts,
  problem,
  showError,
  onChange,
  onHostChange,
}) => {
  const { t } = useI18n();
  const shown = showError ? problem : null;
  // A host that was deleted from the vault is still the saved choice: show
  // that something is selected instead of silently displaying nothing.
  const hostKnown = sshHosts.some((host) => host.id === sshHostId);

  return (
    <>
      <p className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        {t('databases.onhost.intro')}
      </p>

      <div className="grid gap-2">
        <Label htmlFor="db-onhost-host">{t('databases.onhost.host')}</Label>
        <Select value={hostKnown ? sshHostId : ''} onValueChange={onHostChange}>
          <SelectTrigger id="db-onhost-host">
            <SelectValue placeholder={t('databases.onhost.hostPlaceholder')} />
          </SelectTrigger>
          <SelectContent>
            {sshHosts.map((host) => (
              <SelectItem key={host.id} value={host.id}>
                {host.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {sshHosts.length === 0 ? (
          <p className="text-xs text-destructive">{t('databases.onhost.noHosts')}</p>
        ) : shown === 'host' ? (
          <p className="text-xs text-destructive">{t('databases.onhost.hostRequired')}</p>
        ) : (
          <p className="text-xs text-muted-foreground">{t('databases.onhost.hostHint')}</p>
        )}
      </div>

      <div className="grid gap-2">
        <Label htmlFor="db-onhost-mode">{t('databases.onhost.mode')}</Label>
        <Select value={value.mode} onValueChange={(mode) => onChange({ mode: mode as OnHostDatabaseMode })}>
          <SelectTrigger id="db-onhost-mode">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ON_HOST_DATABASE_MODES.map((mode) => (
              <SelectItem key={mode} value={mode}>
                {t(`databases.onhost.mode.${mode}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">{t(`databases.onhost.modeHint.${value.mode}`)}</p>
      </div>

      {value.mode === 'config' ? (
        <div className="grid gap-2">
          <Label htmlFor="db-onhost-dbno">{t('databases.onhost.dbNo')}</Label>
          <Input
            id="db-onhost-dbno"
            className="w-32"
            value={value.dbNo}
            inputMode="numeric"
            placeholder={t('databases.onhost.dbNoPlaceholder')}
            onChange={(event) => onChange({ dbNo: event.target.value.replace(/[^0-9]/g, '').slice(0, 2) })}
          />
          <p className="text-xs text-muted-foreground">{t('databases.onhost.dbNoHint')}</p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-[160px_1fr] gap-3">
            <div className="grid gap-2">
              <Label htmlFor="db-onhost-type">{t('databases.onhost.dbType')}</Label>
              <Select
                value={value.dbType}
                onValueChange={(dbType) => onChange({ dbType: dbType as OnHostDatabaseType })}
              >
                <SelectTrigger id="db-onhost-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ON_HOST_DATABASE_TYPES.map((dbType) => (
                    <SelectItem key={dbType} value={dbType}>
                      {dbType}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="db-onhost-server">{t('databases.onhost.server')}</Label>
              <Input
                id="db-onhost-server"
                className="font-mono text-xs"
                value={value.server}
                placeholder={t('databases.onhost.serverPlaceholder')}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => onChange({ server: event.target.value })}
              />
            </div>
          </div>
          {shown === 'direct' ? (
            <p className="text-xs text-destructive">{t('databases.onhost.directRequired')}</p>
          ) : null}
        </>
      )}

      <div className="grid gap-2">
        <Label>{t('databases.onhost.loginSteps')}</Label>
        <p className="text-xs text-muted-foreground">{t('databases.onhost.loginStepsHint')}</p>
        {value.loginSteps.length > 0 ? (
          <div className="grid gap-1.5">
            <div className="grid grid-cols-[1fr_1fr_28px] gap-2 text-[11px] text-muted-foreground">
              <span>{t('databases.onhost.stepExpect')}</span>
              <span>{t('databases.onhost.stepSend')}</span>
              <span />
            </div>
            {value.loginSteps.map((step, index) => (
              // Rows have no identity of their own; the position is stable
              // while typing, which is all the inputs need to keep focus.
              <div key={index} className="grid grid-cols-[1fr_1fr_28px] items-center gap-2">
                <Input
                  className="h-8 font-mono text-xs"
                  value={step.expect}
                  aria-label={`${t('databases.onhost.stepExpect')} ${index + 1}`}
                  placeholder={index === 0 ? t('databases.onhost.stepExpectPlaceholder') : undefined}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) =>
                    onChange({
                      loginSteps: updateOnHostLoginStep(value.loginSteps, index, { expect: event.target.value }),
                    })
                  }
                />
                <Input
                  className="h-8 font-mono text-xs"
                  value={step.send}
                  aria-label={`${t('databases.onhost.stepSend')} ${index + 1}`}
                  placeholder={index === 0 ? t('databases.onhost.stepSendPlaceholder') : undefined}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) =>
                    onChange({
                      loginSteps: updateOnHostLoginStep(value.loginSteps, index, { send: event.target.value }),
                    })
                  }
                />
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 w-7 p-0"
                  aria-label={t('databases.onhost.removeStep')}
                  title={t('databases.onhost.removeStep')}
                  onClick={() => onChange({ loginSteps: removeOnHostLoginStep(value.loginSteps, index) })}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>
        ) : null}
        {shown === 'step' ? (
          <p className="text-xs text-destructive">{t('databases.onhost.stepExpectRequired')}</p>
        ) : null}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 self-start justify-self-start text-xs"
          disabled={!canAddOnHostLoginStep(value)}
          onClick={() => onChange({ loginSteps: addOnHostLoginStep(value.loginSteps) })}
        >
          <Plus className="mr-1 h-3 w-3" />
          {t('databases.onhost.addStep')}
        </Button>
        {value.loginSteps.length > 0 ? (
          <p className="text-xs text-amber-600 dark:text-amber-400">{t('databases.onhost.loginStepsWarning')}</p>
        ) : null}
      </div>

      <div className="grid gap-2">
        <Label htmlFor="db-onhost-env">{t('databases.onhost.envCommand')}</Label>
        <Input
          id="db-onhost-env"
          className="font-mono text-xs"
          value={value.envCommand}
          placeholder=". ~/.bash_profile"
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => onChange({ envCommand: event.target.value })}
        />
        <p className="text-xs text-muted-foreground">{t('databases.onhost.envCommandHint')}</p>
      </div>

      <div className="grid gap-2">
        <Label htmlFor="db-onhost-python">{t('databases.onhost.python')}</Label>
        <Input
          id="db-onhost-python"
          className="font-mono text-xs"
          value={value.python}
          placeholder={t('databases.onhost.pythonPlaceholder')}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => onChange({ python: event.target.value })}
        />
        {shown === 'python' ? (
          <p className="text-xs text-destructive">{t('databases.onhost.pythonInvalid')}</p>
        ) : (
          <p className="text-xs text-muted-foreground">{t('databases.onhost.pythonHint')}</p>
        )}
      </div>
    </>
  );
};

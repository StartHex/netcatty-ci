/**
 * The on-host part of the database connection form.
 *
 * The form keeps what was typed (text fields, half-filled rows); these helpers
 * turn it into settings and back, and say what is still missing before the
 * connection can be saved or tested.
 */

import {
  ON_HOST_MAX_LOGIN_STEPS,
  type OnHostDatabaseMode,
  type OnHostDatabaseSettings,
  type OnHostDatabaseType,
  type OnHostLoginStep,
} from '../models/database';

export interface OnHostFormValue {
  mode: OnHostDatabaseMode;
  /** Number of the db.cfg entry as typed; empty means the file's default. */
  dbNo: string;
  dbType: OnHostDatabaseType;
  server: string;
  envCommand: string;
  python: string;
  /** Rows as typed, including rows that are not filled in yet. */
  loginSteps: OnHostLoginStep[];
}

export const EMPTY_ON_HOST_FORM: OnHostFormValue = {
  mode: 'config',
  dbNo: '',
  dbType: 'dmdb',
  server: '',
  envCommand: '',
  python: '',
  loginSteps: [],
};

/** What the host's shell accepts as an interpreter path without quoting. */
const SAFE_PROGRAM = /^[A-Za-z0-9_./+-]+$/;

export function onHostFormFromSettings(settings: OnHostDatabaseSettings | undefined): OnHostFormValue {
  if (!settings) return { ...EMPTY_ON_HOST_FORM, loginSteps: [] };
  return {
    mode: settings.mode === 'direct' ? 'direct' : 'config',
    dbNo: settings.dbNo ? String(settings.dbNo) : '',
    dbType: settings.dbType ?? EMPTY_ON_HOST_FORM.dbType,
    server: settings.server ?? '',
    envCommand: settings.envCommand ?? '',
    python: settings.python ?? '',
    loginSteps: (settings.loginSteps ?? []).map((step) => ({ ...step })),
  };
}

/**
 * The settings the form describes. Rows nothing was typed into are left out;
 * the connection sanitizer does the rest (limits, mode-specific fields).
 */
export function onHostSettingsFromForm(form: OnHostFormValue): OnHostDatabaseSettings {
  const dbNo = Number(form.dbNo);
  const loginSteps = form.loginSteps
    .filter((step) => step.expect.trim() !== '' || step.send !== '')
    .map((step) => ({ ...step, expect: step.expect.trim() }));
  return {
    mode: form.mode,
    ...(Number.isInteger(dbNo) && dbNo > 0 ? { dbNo } : {}),
    dbType: form.dbType,
    server: form.server.trim(),
    envCommand: form.envCommand.trim(),
    python: form.python.trim(),
    ...(loginSteps.length > 0 ? { loginSteps } : {}),
  };
}

/**
 * What keeps the form from being saved, most basic first:
 *   host    no SSH host chosen: there is nowhere to run
 *   direct  direct mode without a server or a user name
 *   step    a row says what to type but not what to wait for
 *   python  an interpreter path the shell would not take as one word
 */
export type OnHostFormProblem = 'host' | 'direct' | 'step' | 'python';

export function onHostFormProblem(input: {
  sshHostId: string;
  username: string;
  form: OnHostFormValue;
}): OnHostFormProblem | null {
  const { form } = input;
  if (!input.sshHostId) return 'host';
  if (form.mode === 'direct' && (!form.server.trim() || !input.username.trim())) return 'direct';
  if (form.loginSteps.some((step) => step.expect.trim() === '' && step.send !== '')) return 'step';
  const python = form.python.trim();
  if (python && !SAFE_PROGRAM.test(python)) return 'python';
  return null;
}

export function canAddOnHostLoginStep(form: OnHostFormValue): boolean {
  return form.loginSteps.length < ON_HOST_MAX_LOGIN_STEPS;
}

export function addOnHostLoginStep(steps: readonly OnHostLoginStep[]): OnHostLoginStep[] {
  if (steps.length >= ON_HOST_MAX_LOGIN_STEPS) return [...steps];
  return [...steps, { expect: '', send: '' }];
}

export function updateOnHostLoginStep(
  steps: readonly OnHostLoginStep[],
  index: number,
  patch: Partial<Pick<OnHostLoginStep, 'expect' | 'send'>>,
): OnHostLoginStep[] {
  return steps.map((step, position) => (position === index ? { ...step, ...patch } : step));
}

export function removeOnHostLoginStep(steps: readonly OnHostLoginStep[], index: number): OnHostLoginStep[] {
  return steps.filter((_step, position) => position !== index);
}

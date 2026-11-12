import { filterDoctorChecks } from './checks.js';

export type {
  AgoraDoctorCheck,
  AgoraDoctorReport,
  AgoraDoctorResult,
  AgoraDoctorStatus,
} from './agora_doctor.js';
export { filterDoctorChecks } from './checks.js';

/** The filter doctor checks, read by `agora:doctor --no-boot`. */
export const agoraDoctorChecks = filterDoctorChecks();

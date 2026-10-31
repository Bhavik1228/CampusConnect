import type { PrerequisiteEntity } from './prerequisite-records';

export type PrerequisiteModule = 'assignments' | 'timetable';
export type PrerequisiteAvailability = 'loading' | 'failed' | 'empty' | 'inactive' | 'filtered' | 'ready';

export type PrerequisiteRule = {
  fieldKey: string;
  module: PrerequisiteModule;
  entity: PrerequisiteEntity;
  isRequired: boolean;
  quickCreateEnabled: boolean;
  allowedCreatorRoles: string[];
  fullCreateRoute: string;
  selectionStrategy: 'select-created-record';
  emptyTitle: string;
  emptyMessage: string;
  filteredMessage: string;
};

const createRoles = ['school_admin', 'academic_coordinator'];
const rules: Record<PrerequisiteModule, Record<PrerequisiteEntity, PrerequisiteRule>> = {
  assignments: {
    class: {
      fieldKey: 'class_id',
      module: 'assignments',
      entity: 'class',
      isRequired: true,
      quickCreateEnabled: true,
      allowedCreatorRoles: createRoles,
      fullCreateRoute: '/classes',
      selectionStrategy: 'select-created-record',
      emptyTitle: 'No classes available',
      emptyMessage: 'No classes have been added to this school yet.',
      filteredMessage: 'No classes are eligible for this assignment. Check the school calendar and academic year.',
    },
    subject: {
      fieldKey: 'subject_id',
      module: 'assignments',
      entity: 'subject',
      isRequired: true,
      quickCreateEnabled: true,
      allowedCreatorRoles: createRoles,
      fullCreateRoute: '/subjects',
      selectionStrategy: 'select-created-record',
      emptyTitle: 'No subjects available',
      emptyMessage: 'No subjects have been configured for this school yet.',
      filteredMessage: 'No subjects are eligible for this class.',
    },
    teacher: {
      fieldKey: 'teacher_id',
      module: 'assignments',
      entity: 'teacher',
      isRequired: true,
      quickCreateEnabled: true,
      allowedCreatorRoles: ['school_admin'],
      fullCreateRoute: '/teachers',
      selectionStrategy: 'select-created-record',
      emptyTitle: 'No teachers available',
      emptyMessage: 'There are currently no active teachers available for this school.',
      filteredMessage: 'Teachers exist, but none are assigned to the selected class.',
    },
  },
  timetable: {
    class: {
      fieldKey: 'class_id',
      module: 'timetable',
      entity: 'class',
      isRequired: true,
      quickCreateEnabled: true,
      allowedCreatorRoles: createRoles,
      fullCreateRoute: '/classes',
      selectionStrategy: 'select-created-record',
      emptyTitle: 'No classes available',
      emptyMessage: 'No classes have been added to this school calendar yet.',
      filteredMessage: 'No classes are configured for the selected academic year.',
    },
    subject: {
      fieldKey: 'subject_id',
      module: 'timetable',
      entity: 'subject',
      isRequired: true,
      quickCreateEnabled: true,
      allowedCreatorRoles: createRoles,
      fullCreateRoute: '/subjects',
      selectionStrategy: 'select-created-record',
      emptyTitle: 'No subjects available',
      emptyMessage: 'No subjects have been configured for this school yet.',
      filteredMessage: 'No subjects are assigned to the selected class.',
    },
    teacher: {
      fieldKey: 'teacher_id',
      module: 'timetable',
      entity: 'teacher',
      isRequired: false,
      quickCreateEnabled: true,
      allowedCreatorRoles: ['school_admin'],
      fullCreateRoute: '/teachers',
      selectionStrategy: 'select-created-record',
      emptyTitle: 'No eligible teachers available',
      emptyMessage: 'There are currently no active teachers available for this school.',
      filteredMessage: 'No teachers are assigned to teach this subject in the selected class.',
    },
  },
};

export function getPrerequisiteRule(module: PrerequisiteModule, entity: PrerequisiteEntity) {
  return rules[module][entity];
}

export function canCreatePrerequisite(rule: PrerequisiteRule, role: string | undefined) {
  return rule.quickCreateEnabled && Boolean(role && rule.allowedCreatorRoles.includes(role));
}

export function resolvePrerequisiteAvailability({
  loading,
  error,
  totalRecords,
  selectableRecords,
  inactiveRecords = 0,
  filteredRecords = 0,
}: {
  loading: boolean;
  error: string;
  totalRecords: number;
  selectableRecords: number;
  inactiveRecords?: number;
  filteredRecords?: number;
}): PrerequisiteAvailability {
  if (loading) return 'loading';
  if (error) return 'failed';
  if (selectableRecords > 0) return 'ready';
  if (filteredRecords > 0) return 'filtered';
  if (inactiveRecords > 0) return 'inactive';
  return totalRecords > 0 ? 'filtered' : 'empty';
}

module.exports = ({ config }) => {
  const projectId = process.env.EXPO_PUBLIC_EAS_PROJECT_ID || config.extra?.eas?.projectId;
  const updates = projectId
    ? {
        url: `https://u.expo.dev/${projectId}`,
        checkAutomatically: 'ON_LOAD',
      }
    : { enabled: false };

  return {
    ...config,
    runtimeVersion: { policy: 'appVersion' },
    updates,
    extra: {
      ...config.extra,
      ...(projectId ? { eas: { ...config.extra?.eas, projectId } } : {}),
    },
  };
};

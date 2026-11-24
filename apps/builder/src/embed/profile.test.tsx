import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DevProfileProvider, ProfileProvider, useProfile } from '@/embed/profile';

const Probe = () => <span data-testid="p">{useProfile()}</span>;

afterEach(() => vi.unstubAllEnvs());

describe('profile', () => {
  it('is full without a provider', () => {
    render(<Probe />);
    expect(screen.getByTestId('p')).toHaveTextContent('full');
  });
  it('is whatever the nearest provider says', () => {
    render(
      <ProfileProvider profile="dms-v1">
        <Probe />
      </ProfileProvider>,
    );
    expect(screen.getByTestId('p')).toHaveTextContent('dms-v1');
  });
  it('the standalone builder ignores ?fp_profile in a normal build', () => {
    render(
      <DevProfileProvider search="?fp_profile=dms-v1">
        <Probe />
      </DevProfileProvider>,
    );
    expect(screen.getByTestId('p')).toHaveTextContent('full');
  });
  it('and honours it only when the build sets VITE_FP_DEV_OVERRIDES=1', () => {
    vi.stubEnv('VITE_FP_DEV_OVERRIDES', '1');
    render(
      <DevProfileProvider search="?fp_profile=dms-v1">
        <Probe />
      </DevProfileProvider>,
    );
    expect(screen.getByTestId('p')).toHaveTextContent('dms-v1');
  });
});

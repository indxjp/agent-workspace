import { describe, expect, it } from 'vitest';

import type { DeploymentImages } from '../deployment.js';
import { defaultProfile } from '../profile-defaults.js';
import { renderTerraformVariables } from './terraform-vars.js';

const digest = (character: string) => `sha256:${character.repeat(64)}`;
const images: DeploymentImages = {
  web: `registry.example/web@${digest('1')}`,
  gateway: `registry.example/gateway@${digest('2')}`,
  runner: `registry.example/runner@${digest('3')}`,
  runtime: `registry.example/runtime@${digest('4')}`,
};
const toolHost = `registry.example/tool-host@${digest('8')}`;
const egressProxy = `registry.example/egress-proxy@${digest('7')}`;

const imagesOf = (cloud: 'gcp' | 'azure', given: DeploymentImages): unknown => {
  const rendered = renderTerraformVariables(
    defaultProfile({ cloud, projectName: 'acme-ai' }),
    given,
  );
  return (JSON.parse(rendered?.contents ?? '{}') as { images: unknown }).images;
};

describe('the images object of the Terraform variables', () => {
  it('holds the four images alone while no egress proxy is given', () => {
    expect(imagesOf('gcp', images)).toEqual({
      web: images.web,
      gateway: images.gateway,
      runner: images.runner,
      runtime: images.runtime,
    });
  });

  it('adds egress_proxy for the gcp-cloudrun module when the proxy is given', () => {
    expect(imagesOf('gcp', { ...images, egressProxy })).toEqual({
      web: images.web,
      gateway: images.gateway,
      runner: images.runner,
      runtime: images.runtime,
      egress_proxy: egressProxy,
    });
  });

  it('adds tool_host for the gcp-cloudrun module when the tool host is given', () => {
    expect(imagesOf('gcp', { ...images, toolHost })).toEqual({
      web: images.web,
      gateway: images.gateway,
      runner: images.runner,
      runtime: images.runtime,
      tool_host: toolHost,
    });
  });

  it('never renders tool_host for another module', () => {
    expect(imagesOf('azure', { ...images, toolHost })).not.toHaveProperty('tool_host');
  });

  it('never renders egress_proxy for another module', () => {
    expect(imagesOf('azure', { ...images, egressProxy })).not.toHaveProperty('egress_proxy');
  });
});

/** @jsxImportSource @bedrock-core/ui-runtime */
import { AddonPage } from '@bedrock-core/config/compiled';
import type { JSX } from '@bedrock-core/ui-runtime';
import { manifest } from '../addon';

/** This addon's page in the shared addon list: baked here, drawn into the host's list. */
export default function ShopPage(): JSX.Element {
  return <AddonPage addon={manifest} />;
}

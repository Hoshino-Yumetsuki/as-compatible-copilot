<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import './style.css';

type ProviderKind = 'anthropic' | 'google' | 'openai-compatible' | 'openai-responses';
type Profile = { id: string; provider: ProviderKind; baseURL?: string; discover?: boolean };
type Model = {
  id: string; name?: string; provider: ProviderKind; model: string; profileId?: string;
  baseURL?: string; contextLength?: number; maxOutputTokens?: number; toolCalling?: boolean; imageInput?: boolean;
};
type Settings = { reasoningEffort: string; contextLength: number; modelOverrides: Record<string, unknown> };
type State = { profiles: Profile[]; models: Model[]; manualModelIds: string[]; settings: Settings; keys: Record<string, boolean> };
type ModelInput = { model: string; profileId: string; contextLength?: number; maxOutputTokens?: number; toolCalling?: boolean; imageInput?: boolean };
type FormModel = Omit<ModelInput, 'toolCalling' | 'imageInput'> & { toolCalling: '' | 'true' | 'false'; imageInput: '' | 'true' | 'false' };
type Message =
  | { type: 'refresh'; force?: boolean }
  | { type: 'saveSettings'; settings: Settings }
  | { type: 'saveProfile'; profile: Profile; originalId?: string; apiKey?: string }
  | { type: 'deleteProfile'; id: string }
  | { type: 'saveModel'; model: ModelInput; originalId?: string }
  | { type: 'deleteModel'; id: string };

declare const acquireVsCodeApi: () => { postMessage(message: Message): void };
const vscode = acquireVsCodeApi();
const blankProfile = (): Profile & { apiKey: string } => ({ id: '', provider: 'openai-compatible', baseURL: '', discover: true, apiKey: '' });
const blankModel = (): FormModel => ({ model: '', profileId: '', contextLength: undefined, maxOutputTokens: undefined, toolCalling: '', imageInput: '' });

    const state = reactive<State>({ profiles: [], models: [], manualModelIds: [], settings: { reasoningEffort: 'medium', contextLength: 256000, modelOverrides: {} }, keys: {} });
    const status = ref('Loading configuration');
    const error = ref('');
    const profileDraft = reactive(blankProfile());
    const modelDraft = reactive(blankModel());
    const editingProfile = ref<string>();
    const editingModel = ref<string>();
    const expandedProfile = ref<string>();
    const expandedModel = ref<string>();
    const selectedProfile = computed(() => state.profiles.find((profile) => profile.id === modelDraft.profileId));
    const providerLabel = (provider: ProviderKind) => provider.replace('-', ' ');
    const isManual = (model: Model) => state.manualModelIds.includes(model.id);
    const modelLabel = (model: Model) => model.name || model.model;
    const resetProfile = (profile?: Profile) => Object.assign(profileDraft, profile ? { ...profile, apiKey: '' } : blankProfile());
    const resetModel = (model?: Model) => Object.assign(modelDraft, model ? {
      model: model.model, profileId: model.profileId || '', contextLength: model.contextLength, maxOutputTokens: model.maxOutputTokens,
      toolCalling: model.toolCalling === undefined ? '' : String(model.toolCalling) as 'true' | 'false', imageInput: model.imageInput === undefined ? '' : String(model.imageInput) as 'true' | 'false'
    } : blankModel());
    const showError = (message: string) => { error.value = message; status.value = 'Action failed'; };
    const openProfile = (profile?: Profile) => {
      resetProfile(profile); editingProfile.value = profile?.id; expandedProfile.value = profile?.id || '__new__';
    };
    const openModel = (model?: Model) => {
      resetModel(model); editingModel.value = model?.id; expandedModel.value = model?.id || '__new__';
    };
    const closeProfile = () => { expandedProfile.value = undefined; editingProfile.value = undefined; };
    const closeModel = () => { expandedModel.value = undefined; editingModel.value = undefined; };
    const saveProfile = () => {
      vscode.postMessage({ type: 'saveProfile', profile: { id: profileDraft.id.trim(), provider: profileDraft.provider, baseURL: profileDraft.baseURL?.trim(), discover: true }, originalId: editingProfile.value, apiKey: profileDraft.apiKey.trim() || undefined });
      closeProfile();
    };
    const saveModel = () => {
      const profile = selectedProfile.value;
      if (!profile) return showError('Choose a provider profile.');
      const model: ModelInput = {
        model: modelDraft.model.trim(), profileId: profile.id,
        contextLength: modelDraft.contextLength || undefined, maxOutputTokens: modelDraft.maxOutputTokens || undefined,
        ...(modelDraft.toolCalling ? { toolCalling: modelDraft.toolCalling === 'true' } : {}),
        ...(modelDraft.imageInput ? { imageInput: modelDraft.imageInput === 'true' } : {})
      };
      vscode.postMessage({ type: 'saveModel', model, originalId: editingModel.value });
      closeModel();
    };
    const removeProfile = (profile: Profile) => {
      vscode.postMessage({ type: 'deleteProfile', id: profile.id });
    };
    const removeModel = (model: Model) => {
      if (confirm(`Delete ${model.id}?`)) vscode.postMessage({ type: 'deleteModel', id: model.id });
    };
    const refresh = () => { status.value = 'Refreshing models'; vscode.postMessage({ type: 'refresh', force: true }); };
    const saveSettings = () => vscode.postMessage({ type: 'saveSettings', settings: { ...state.settings, contextLength: Number(state.settings.contextLength) } });
    window.addEventListener('message', ({ data }) => {
      if (data?.type === 'state') { Object.assign(state, data); status.value = 'Configuration loaded'; error.value = ''; }
      if (data?.type === 'operation') { status.value = data.operation ? String(data.operation) : 'Ready'; error.value = ''; }
      if (data?.type === 'error') showError(String(data.error));
    });
    vscode.postMessage({ type: 'refresh' });

</script>

<template>
    <header>
      <div><p class="eyebrow">AS COMPATIBLE COPILOT</p><h1>Provider control center</h1><p class="muted">Manage endpoints, credentials, models, and Copilot behavior.</p></div>
      <button class="secondary" @click="refresh">Refresh models</button>
    </header>
    <main>
      <section><div class="section-heading"><div><h2>Global settings</h2><p class="muted">Defaults applied unless a model overrides them.</p></div><span class="status" :class="{ error }">{{ status }}</span></div>
        <div class="form-grid"><label>Reasoning effort<select v-model="state.settings.reasoningEffort"><option v-for="value in ['low','medium','high','xhigh','max']" :key="value">{{ value }}</option></select></label><label>Context length<input v-model.number="state.settings.contextLength" type="number" min="1" /></label></div><button type="button" @click="saveSettings">Save settings</button>
      </section>
      <section><div class="section-heading"><div><h2>Provider profiles</h2><p class="muted">Credentials are saved in VS Code Secret Storage.</p></div><button type="button" @click="openProfile()">Add provider</button></div>
        <div class="list"><article v-for="profile in state.profiles" :key="profile.id" class="row" :class="{ expanded: expandedProfile === profile.id }"><div class="row-summary"><div><strong>{{ profile.id }}</strong><p>{{ providerLabel(profile.provider) }}<span v-if="profile.baseURL"> · {{ profile.baseURL }}</span> · <span class="secret">{{ state.keys[profile.id] ? 'API key stored' : 'No API key' }}</span></p></div><div class="row-actions"><button type="button" class="secondary" @click.stop.prevent="openProfile(profile)">Edit</button><button type="button" class="secondary danger" @click.stop.prevent="removeProfile(profile)">Delete</button></div></div>
          <form v-if="expandedProfile === profile.id" @submit.prevent="saveProfile" class="editor"><h3>Edit provider</h3><div class="form-grid"><label>Profile ID<input v-model.trim="profileDraft.id" required /></label><label>Provider<select v-model="profileDraft.provider"><option v-for="provider in ['openai-compatible','openai-responses','anthropic','google']" :key="provider">{{ provider }}</option></select></label><label class="wide">Base URL<input v-model.trim="profileDraft.baseURL" placeholder="https://api.example.com/v1" /></label><label class="wide">API key <span class="secret">leave blank to keep existing</span><input v-model="profileDraft.apiKey" type="password" autocomplete="new-password" /></label></div><div class="editor-actions"><button>Save provider</button><button class="secondary" type="button" @click="closeProfile">Cancel</button></div></form>
        </article><article v-if="expandedProfile === '__new__'" class="row expanded"><form @submit.prevent="saveProfile" class="editor"><h3>Add provider</h3><div class="form-grid"><label>Profile ID<input v-model.trim="profileDraft.id" required /></label><label>Provider<select v-model="profileDraft.provider"><option v-for="provider in ['openai-compatible','openai-responses','anthropic','google']" :key="provider">{{ provider }}</option></select></label><label class="wide">Base URL<input v-model.trim="profileDraft.baseURL" placeholder="https://api.example.com/v1" /></label><label class="wide">API key <span class="secret">stored securely</span><input v-model="profileDraft.apiKey" type="password" autocomplete="new-password" /></label></div><div class="editor-actions"><button>Save provider</button><button class="secondary" type="button" @click="closeProfile">Cancel</button></div></form></article><p v-if="!state.profiles.length && expandedProfile !== '__new__'" class="empty">No provider profiles configured.</p></div>
      </section>
      <section><div class="section-heading"><div><h2>Models</h2><p class="muted">Each model belongs to a provider profile.</p></div><button :disabled="!state.profiles.length" @click="openModel()">Add model</button></div>
        <div class="list"><article v-for="model in state.models" :key="model.id" class="row" :class="{ expanded: expandedModel === model.id }"><div class="row-summary"><div><strong>{{ modelLabel(model) }}</strong><p><code>{{ model.id }}</code> · {{ model.profileId || providerLabel(model.provider) }} · {{ model.contextLength ? model.contextLength + ' context' : 'global context' }}<span v-if="!isManual(model)"> · discovered</span></p></div><div class="row-actions"><button class="secondary" @click="openModel(model)">Edit</button><button v-if="isManual(model)" class="secondary danger" @click="removeModel(model)">Delete</button></div></div>
          <form v-if="expandedModel === model.id" @submit.prevent="saveModel" class="editor"><h3>Edit model</h3><div class="form-grid"><label>Provider profile<select v-model="modelDraft.profileId" required><option disabled value="">Choose a profile</option><option v-for="profile in state.profiles" :key="profile.id" :value="profile.id">{{ profile.id }} · {{ providerLabel(profile.provider) }}</option></select></label><label>Model name<input v-model.trim="modelDraft.model" required /></label><label>Context override<input v-model.number="modelDraft.contextLength" type="number" min="1" /></label><label>Max output tokens<input v-model.number="modelDraft.maxOutputTokens" type="number" min="1" /></label><label>Tools<select v-model="modelDraft.toolCalling"><option value="">Inherit</option><option value="true">Enabled</option><option value="false">Disabled</option></select></label><label>Images<select v-model="modelDraft.imageInput"><option value="">Inherit</option><option value="true">Enabled</option><option value="false">Disabled</option></select></label></div><div class="editor-actions"><button>Save model</button><button class="secondary" type="button" @click="closeModel">Cancel</button></div></form>
        </article><article v-if="expandedModel === '__new__'" class="row expanded"><form @submit.prevent="saveModel" class="editor"><h3>Add model</h3><div class="form-grid"><label>Provider profile<select v-model="modelDraft.profileId" required><option disabled value="">Choose a profile</option><option v-for="profile in state.profiles" :key="profile.id" :value="profile.id">{{ profile.id }} · {{ providerLabel(profile.provider) }}</option></select></label><label>Model name<input v-model.trim="modelDraft.model" required /></label><label>Context override<input v-model.number="modelDraft.contextLength" type="number" min="1" /></label><label>Max output tokens<input v-model.number="modelDraft.maxOutputTokens" type="number" min="1" /></label><label>Tools<select v-model="modelDraft.toolCalling"><option value="">Inherit</option><option value="true">Enabled</option><option value="false">Disabled</option></select></label><label>Images<select v-model="modelDraft.imageInput"><option value="">Inherit</option><option value="true">Enabled</option><option value="false">Disabled</option></select></label></div><div class="editor-actions"><button>Save model</button><button class="secondary" type="button" @click="closeModel">Cancel</button></div></form></article><p v-if="!state.models.length && expandedModel !== '__new__'" class="empty">Add a provider to configure a model; discovered models appear after refresh.</p></div>
      </section>
    </main>
    <div v-if="error" class="toast" role="alert"><strong>Could not save</strong><span>{{ error }}</span><button class="secondary" @click="error = ''">Dismiss</button></div>
</template>
